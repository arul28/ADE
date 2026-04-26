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

enum RemoteConnectionState: String {
  case disconnected
  case connecting
  case connected
  case syncing
  case error

  /// True when the host is not reachable — either we never connected
  /// (or gave up) or the last socket turned over into an error state.
  /// UI uses this to suppress per-screen "failed to load" banners whose
  /// underlying cause is simply "not connected"; the top-right gear dot
  /// (ADEConnectionDot) is the single source of truth for this state.
  var isHostUnreachable: Bool {
    self == .disconnected || self == .error
  }
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

func decodeHydrationPayload<T: Decodable>(_ raw: Any, as type: T.Type, domainLabel: String, decoder: JSONDecoder) throws -> T {
  do {
    let data = try adeJSONData(withJSONObject: raw)
    return try decoder.decode(T.self, from: data)
  } catch {
    throw NSError(
      domain: "ADE",
      code: 18,
      userInfo: [
        NSLocalizedDescriptionKey: "The host returned incomplete \(domainLabel) data. Pull to retry or reconnect the host.",
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
      userInfo: [NSLocalizedDescriptionKey: SyncHydrationMessaging.projectDataTimeout]
    )
  }
}

enum SyncRequestTimeout {
  static let defaultTimeoutNanoseconds: UInt64 = 30_000_000_000
  static let message = "The host took too long to respond. Reconnecting now."

  static func error(message: String = Self.message, underlyingError: Error? = nil) -> NSError {
    var userInfo: [String: Any] = [NSLocalizedDescriptionKey: message]
    if let underlyingError {
      userInfo[NSUnderlyingErrorKey] = underlyingError
    }
    return NSError(domain: "ADE", code: 23, userInfo: userInfo)
  }
}

private let syncTerminalSubscriptionMaxBytes = 80_000
private let syncChatSubscriptionMaxBytes = 2_000_000
private let syncTerminalBufferMaxCharacters = 80_000
private let chatEventHistoryMaxEvents = 1_000

enum SyncBonjourTiming {
  static let searchRetryNanoseconds: UInt64 = 2_000_000_000
  static let resolveRetryNanoseconds: UInt64 = 2_000_000_000
  static let periodicRestartNanoseconds: UInt64 = 30_000_000_000
  static let resolveTimeout: TimeInterval = 10
}

enum SyncSocketTiming {
  static let openTimeoutNanoseconds: UInt64 = 5_000_000_000
  static let lanePresenceHeartbeatNanoseconds: UInt64 = 30_000_000_000
}

enum SyncTailnetDiscoveryTiming {
  static let probeIntervalNanoseconds: UInt64 = 45_000_000_000
  static let probeTimeoutNanoseconds: UInt64 = 2_000_000_000
}

enum SyncTailnetDiscovery {
  static let hostCandidates = [
    "ade-sync",
  ]
  static let portCandidates = [
    8787,
    8788,
  ]
}

enum SyncDirectHostPorts {
  static let defaultPort = 8787
  static let retryWindow = 12
  static let portCandidates = Array(defaultPort...(defaultPort + retryWindow))
}

struct SyncRouteEndpoint: Equatable {
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
    return SyncRouteEndpoint(host: host, port: syncValidRoutePort(components.port))
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

func syncConnectPortCandidates(primaryPort: Int, addresses: [String]) -> [Int] {
  let shouldTryDefaultPair =
    SyncDirectHostPorts.portCandidates.contains(primaryPort)
      || addresses.contains(where: syncIsTailscaleRoute)
  let fallbackPorts = shouldTryDefaultPair ? SyncDirectHostPorts.portCandidates : []
  var seen = Set<Int>()
  return ([primaryPort] + fallbackPorts)
    .compactMap(syncValidRoutePort)
    .filter { seen.insert($0).inserted }
}

func syncWebSocketURLString(host rawHost: String, port defaultPort: Int) -> String? {
  guard let endpoint = syncParseRouteEndpoint(rawHost) else { return nil }
  let port = endpoint.port ?? defaultPort
  guard syncValidRoutePort(port) != nil else { return nil }
  let host = endpoint.host.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !host.isEmpty else { return nil }
  let urlHost = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
  return "ws://\(urlHost):\(port)"
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

struct SyncReconnectState {
  private(set) var attempts = 0

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
}

private struct SyncNetworkPathSnapshot: Equatable, Sendable {
  let isSatisfied: Bool
  let usesWiFi: Bool
  let usesCellular: Bool
  let usesWiredEthernet: Bool
  let isExpensive: Bool
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
  return "satisfied=\(snapshot.isSatisfied) interfaces=\(interfaces.isEmpty ? "none" : interfaces.joined(separator: "+")) expensive=\(snapshot.isExpensive)"
}

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

enum SyncUserFacingError {
  static func message(for error: Error) -> String {
    let nsError = error as NSError
    if let code = nsError.userInfo["ADEErrorCode"] as? String, code == "auth_failed" {
      return "This phone is no longer paired with the host. Pair again from Settings."
    }

    let rawMessage = nsError.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !rawMessage.isEmpty else {
      return "Something interrupted sync. Reconnect to the host and try again."
    }

    let lowered = rawMessage.lowercased()
    if lowered.contains("timed out waiting for host to sync project data") {
      return SyncHydrationMessaging.projectDataTimeout
    }
    if lowered.contains("no project row") || lowered.contains("project data") {
      return SyncHydrationMessaging.waitingForProjectData
    }
    if lowered.contains("host took too long to respond") {
      return SyncRequestTimeout.message
    }
    if lowered.contains("heartbeat") && lowered.contains("reconnect") {
      return "The host stopped responding. Reconnecting now."
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
      return "The connection to the host was interrupted. Reconnecting now."
    }
    if lowered.contains("unable to reach the saved ade host") ||
        lowered.contains("could not connect to the server") ||
        lowered.contains("network is unreachable") ||
        lowered.contains("cannot connect to host") {
      return "Can't reach the saved host right now. Make sure ADE is running on the host, then retry."
    }
    if lowered.contains("no saved address is available for this host") {
      return "This phone no longer has a saved address for the host. Open Settings to rediscover it or pair again."
    }
    if lowered.contains("the host is offline") || lowered.contains("requires a live connection to the host") {
      return "The host is offline. Reconnect, then try again."
    }
    if lowered.contains("the host returned incomplete") {
      return "The host sent incomplete sync data. Retry the affected area or reconnect the host."
    }
    if lowered.contains("pairing secret missing from response") || lowered.contains("invalid hello response") {
      return "The host replied with unexpected pairing data. Reconnect and try again."
    }
    if lowered.contains("authentication failed") {
      return "This phone is no longer paired with the host. Pair again from Settings."
    }
    if lowered.contains("invalid host address") {
      return "The host address looks invalid. Check it and try again."
    }
    if lowered.contains("invalid queued operation payload") ||
        lowered.contains("queued operation payload is invalid") ||
        lowered.contains("unknown queued operation type") {
      return "Queued sync work on this phone became unreadable. Reconnect and try the action again."
    }
    if lowered.contains("remote command rejected") {
      return "The host couldn't accept that request right now. Try again in a moment."
    }
    if lowered.contains("file request failed") {
      return "The host couldn't finish that file request. Try again."
    }
    if lowered.contains("unable to start gzip decoder") || lowered.contains("unable to decode compressed sync payload") {
      return "The host sent unreadable sync data. Reconnect and try again."
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

struct PrNavigationRequest: Equatable, Identifiable {
  let id: String
  let prId: String
  let laneId: String?

  init(prId: String, laneId: String? = nil) {
    self.id = UUID().uuidString
    self.prId = prId
    self.laneId = laneId
  }
}

struct QueuedRemoteCommandError: LocalizedError {
  let action: String

  var errorDescription: String? {
    "That action is queued on the host and will run when the desktop reconnects."
  }
}

@MainActor
final class SyncService: ObservableObject {
  @Published private(set) var connectionState: RemoteConnectionState = .disconnected
  @Published private(set) var hostName: String?
  @Published private(set) var activeHostProfile: HostConnectionProfile?
  @Published private(set) var projects: [MobileProjectSummary] = []
  @Published private(set) var activeProjectId: String?
  @Published private(set) var activeProjectRootPath: String?
  @Published private(set) var projectSwitchInFlightRootPath: String?
  @Published private(set) var discoveredHosts: [DiscoveredSyncHost] = []
  @Published private(set) var domainStatuses: [SyncDomain: SyncDomainStatus] = Dictionary(
    uniqueKeysWithValues: SyncDomain.allCases.map { ($0, .disconnected) }
  )
  @Published private(set) var lastSyncAt: Date?
  @Published private(set) var currentAddress: String?
  @Published private(set) var lastError: String?
  @Published private(set) var terminalBufferRevision = 0
  @Published private(set) var chatEventNotificationRevision = 0
  @Published private(set) var subscribedChatSessionIds: Set<String> = []
  @Published private(set) var pendingOperationCount = 0
  @Published private(set) var localStateRevision = 0
  @Published var settingsPresented = false
  @Published var projectHomePresented = true
  @Published var attentionDrawerPresented = false
  @Published var requestedFilesNavigation: FilesNavigationRequest?
  @Published var requestedLaneNavigation: LaneNavigationRequest?
  @Published var requestedPrNavigation: PrNavigationRequest?

  private(set) var terminalBuffers: [String: String] = [:]
  private(set) var chatEventEnvelopesBySession: [String: [AgentChatEventEnvelope]] = [:]
  private(set) var chatEventRevisionsBySession: [String: Int] = [:]

  private let legacyDraftKey = "ade.sync.connectionDraft"
  private let profileKey = "ade.sync.hostProfile"
  private let profilesKey = "ade.sync.hostProfiles"
  private let legacyDeviceIdKey = "ade.sync.deviceId"
  private let autoReconnectPausedKey = "ade.sync.autoReconnectPausedByUser"
  private let activeProjectIdKey = "ade.sync.activeProjectId"
  private let activeProjectRootPathKey = "ade.sync.activeProjectRootPath"
  private let pendingOperationsKey = "ade.sync.pendingOperations"
  private let remoteCommandDescriptorsKey = "ade.sync.remoteCommandDescriptors"
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
  }

  private var pending: [String: PendingRequest] = [:]
  private var pendingSocketOpen: [Int: CheckedContinuation<Void, Error>] = [:]
  private var pendingSocketOpenTimeoutTasks: [Int: Task<Void, Never>] = [:]
  private let decoder = JSONDecoder()
  private let encoder = JSONEncoder()
  private let compressionThresholdBytes = 4 * 1024
  private var relayTask: Task<Void, Never>?
  private var hydrationTask: Task<Void, Never>?
  private var reconnectTask: Task<Void, Never>?
  private var networkPathReconnectTask: Task<Void, Never>?
  private var lanePresenceHeartbeatTask: Task<Void, Never>?
  private var openLaneReferenceCounts: [String: Int] = [:]
  private var terminalBufferRevisionTask: Task<Void, Never>?
  private var chatEventRevisionTask: Task<Void, Never>?
  private var databaseObserver: NSObjectProtocol?
  /// Coalesces bursty `adeDatabaseDidChange` notifications so SwiftUI `.task(id: localStateRevision)` surfaces
  /// do not reload on every CRDT row during host sync (was freezing the Work tab and Settings UI).
  private var databaseRevisionDebounceTask: Task<Void, Never>?
  private var latestRemoteDbVersion = 0
  private var outboundLocalDbVersion = 0
  private let discoveryBrowser = SyncBonjourBrowser()
  private var reconnectState = SyncReconnectState()
  private var connectionGeneration: UInt64 = 0
  private var connectAttemptGeneration: UInt64 = 0
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
  private var supportsProjectCatalog = false
  private var supportsChatStreaming = false
  private var projectSelectionTask: Task<Void, Never>?
  private var projectSelectionGeneration: UInt64 = 0

  /// Process-wide singleton populated by the first `init` and consumed by
  /// `AppDelegate`, Live Activity intents, and the `@EnvironmentObject`
  /// propagated by `ADEApp`. Optional so tests / previews that spin up a
  /// secondary instance do not clobber the primary one.
  static var shared: SyncService?

  /// Sessions currently eligible for a Live Activity. Rebuilt from
  /// `localStateRevision` changes and consumed by `LiveActivityCoordinator`.
  @Published private(set) var activeSessions: [AgentSnapshot] = []

  /// Owns the iOS 16.2+ Live Activity lifecycle; wired with `self` as host.
  private var liveActivityCoordinator: Any?

  /// 2s debounce task shared by all writers of the App Group workspace
  /// snapshot. Coalesces bursty state changes into a single widget reload.
  private var snapshotDebouncerTask: Task<Void, Never>?

  /// Tracks `activeSessions` derivation so we do not rebuild on every
  /// unrelated `localStateRevision` bump.
  private var activeSessionsObservationTask: Task<Void, Never>?

  /// Backing storage for `attentionDrawer` + the Combine subscriptions it
  /// uses to observe `activeSessions` / `localStateRevision`. Lazily
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
    if let activeProjectId, project.id == activeProjectId {
      return true
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
      lastError = "That project has not been cached on this phone yet. Connect to the ADE desktop app before opening it."
      setDomainStatus(SyncDomain.allCases, phase: .failed, error: lastError)
      return
    }

    guard connectionState != .connected && connectionState != .syncing else {
      lastError = "This computer connection does not support project switching. Reconnect to a current ADE desktop app before opening another project."
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

  func refreshProjectCatalog(preferRemoteSelection: Bool = false) {
    let cachedProjects = database.listMobileProjects()
    var mergedById = Dictionary(uniqueKeysWithValues: deduplicatedRemoteProjectCatalog().map { ($0.id, $0) })
    for cachedProject in cachedProjects {
      if var existing = mergedById[cachedProject.id] {
        existing.displayName = cachedProject.displayName
        existing.rootPath = cachedProject.rootPath ?? existing.rootPath
        existing.defaultBaseRef = cachedProject.defaultBaseRef ?? existing.defaultBaseRef
        existing.lastOpenedAt = cachedProject.lastOpenedAt ?? existing.lastOpenedAt
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
        mergedById.removeValue(forKey: match.key)
        existing.id = cachedProject.id
        existing.displayName = cachedProject.displayName
        existing.defaultBaseRef = cachedProject.defaultBaseRef ?? existing.defaultBaseRef
        existing.lastOpenedAt = cachedProject.lastOpenedAt ?? existing.lastOpenedAt
        existing.laneCount = cachedProject.laneCount
        existing.isCached = true
        existing.isAvailable = existing.isAvailable || cachedProject.isAvailable
        mergedById[cachedProject.id] = existing
      } else {
        mergedById[cachedProject.id] = cachedProject
      }
    }
    if let activeProjectId,
       mergedById[activeProjectId] == nil,
       let activeProjectRootPath,
       let match = mergedById.first(where: { entry in
         normalizedProjectRoot(entry.value.rootPath) == activeProjectRootPath
       }) {
      if match.value.isCached {
        setActiveProjectId(match.value.id, rootPath: match.value.rootPath)
      } else {
        var existing = match.value
        mergedById.removeValue(forKey: match.key)
        existing.id = activeProjectId
        mergedById[activeProjectId] = existing
      }
    }
    projects = mergedById.values.sorted { left, right in
      if isActiveProject(left) { return true }
      if isActiveProject(right) { return false }
      let leftOpen = left.isOpen ?? true
      let rightOpen = right.isOpen ?? true
      if leftOpen != rightOpen { return leftOpen }
      return (left.lastOpenedAt ?? "") > (right.lastOpenedAt ?? "")
    }
    if preferRemoteSelection {
      preferActiveProjectFromRemoteCatalogIfNeeded()
    }
    normalizeActiveProjectSelection(allowSingleProjectFallback: false)
  }

  private func preferActiveProjectFromRemoteCatalogIfNeeded() {
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
    let preferred = remoteProjects.sorted { left, right in
      if left.isAvailable != right.isAvailable { return left.isAvailable }
      return (left.lastOpenedAt ?? "") > (right.lastOpenedAt ?? "")
    }.first
    if let preferred {
      setActiveProjectId(preferred.id, rootPath: preferred.rootPath)
    }
  }

  private func deduplicatedRemoteProjectCatalog() -> [MobileProjectSummary] {
    var byId: [String: MobileProjectSummary] = [:]
    var idByRoot: [String: String] = [:]

    for project in remoteProjectCatalog {
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

  private func applyRemoteProjectCatalog(_ catalog: MobileProjectCatalogPayload) {
    remoteProjectCatalog = catalog.projects
    refreshProjectCatalog(preferRemoteSelection: true)
  }

  private func refreshRemoteProjectCatalog() async {
    guard supportsProjectCatalog, canSendLiveRequests() else { return }
    let requestId = makeRequestId()
    do {
      let raw = try await awaitResponse(
        requestId: requestId,
        disconnectOnTimeout: false,
        timeoutMessage: "Timed out waiting for the desktop project list."
      ) {
        self.sendEnvelope(type: "project_catalog_request", requestId: requestId, payload: [:])
      }
      let catalog = try decode(raw, as: MobileProjectCatalogPayload.self)
      applyRemoteProjectCatalog(catalog)
    } catch {
      syncConnectLog.info("project catalog refresh failed error=\(String(describing: error), privacy: .public)")
    }
  }

  private func switchToDesktopProject(
    _ project: MobileProjectSummary,
    rootPath: String,
    selectionGeneration: UInt64
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
        NSLocalizedDescriptionKey: result.message ?? "The desktop could not open that project for phone sync."
      ])
    }
    guard isCurrentProjectSelection(selectionGeneration) else {
      throw CancellationError()
    }

    let targetProject = result.project ?? project
    let previousActiveProjectId = activeProjectId
    let previousActiveProjectRootPath = activeProjectRootPath
    let previousProfile = loadProfile()
    let previousToken = previousProfile.flatMap { token(for: $0) } ?? keychain.loadToken()
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

    guard let connection = result.connection else {
      // Desktop's success path for project_switch_request intentionally returns
      // no connection bundle — the phone keeps its existing pairing creds and
      // reconnects via the WebSocket. Treat this as a successful switch:
      // preserve the new active project, tear down any live socket, and let
      // reconnectIfPossible re-establish streaming for the new project.
      projectHomePresented = false
      localStateRevision += 1
      refreshActiveSessionsAndSnapshot()
      scheduleWorkspaceSnapshotWrite()
      // Clear stale failure state from the prior project so the reconnect gap
      // shows active handoff progress instead of a leftover failure banner.
      lastError = nil
      let hadLiveSocket = connectionState == .connected || connectionState == .syncing
      if hadLiveSocket {
        teardownSocket(reason: "Switching desktop project.")
      }
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
        NSLocalizedDescriptionKey: "The desktop did not provide an address for that project."
      ])
    }

    let bundledToken = connection.token?.trimmingCharacters(in: .whitespacesAndNewlines)
    let hasBundledToken = bundledToken?.isEmpty == false
    let resolvedToken = hasBundledToken ? bundledToken : previousToken
    guard let resolvedToken else {
      throw NSError(domain: "ADE", code: 26, userInfo: [
        NSLocalizedDescriptionKey: "The desktop did not provide credentials for that project, and this phone has no saved pairing for the host."
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
      saveProfile(profile)
      teardownSocket(reason: "Switching desktop project.")
      let connectedEndpoint = try await connectUsingProfile(
        profile,
        token: resolvedToken,
        connectAttemptGeneration: connectAttemptGeneration,
        preferLiveCandidatesOnly: false,
        publishConnecting: true
      )
      guard isCurrentConnectAttempt(connectAttemptGeneration), isCurrentProjectSelection(selectionGeneration) else { return }
      currentAddress = connectedEndpoint.host
      projectHomePresented = false
      localStateRevision += 1
      refreshActiveSessionsAndSnapshot()
      scheduleWorkspaceSnapshotWrite()
    } catch {
      guard isCurrentProjectSelection(selectionGeneration) else {
        throw error
      }
      setActiveProjectId(previousActiveProjectId, rootPath: previousActiveProjectRootPath)
      latestRemoteDbVersion = previousLatestRemoteDbVersion
      remoteProjectCatalog = previousRemoteProjectCatalog
      if let previousToken {
        keychain.saveToken(previousToken)
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
    activeProjectId = projectId
    activeProjectRootPath = projectId == nil
      ? nil
      : normalizedProjectRoot(rootPath)
        ?? projectId.flatMap { id in
          projects.first { $0.id == id }.flatMap { normalizedProjectRoot($0.rootPath) }
        }
    database.setActiveProjectId(projectId)
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
  }

  private func normalizeActiveProjectSelection(allowSingleProjectFallback: Bool) {
    let projectIds = Set(projects.map(\.id))
    if let activeProjectId, projectIds.contains(activeProjectId) {
      database.setActiveProjectId(activeProjectId)
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
    guard var root = rootPath?.trimmingCharacters(in: .whitespacesAndNewlines),
          !root.isEmpty
    else { return nil }
    while root.count > 1, root.hasSuffix("/") {
      root.removeLast()
    }
    return root
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
    database.setActiveProjectId(activeProjectId)
    projects = database.listMobileProjects()
    normalizeActiveProjectSelection(allowSingleProjectFallback: false)
    pendingOperationCount = loadPendingOperations().count
    outboundLocalDbVersion = database.currentDbVersion()
    activeHostProfile = loadProfile()
    hostName = activeHostProfile?.hostName
    latestRemoteDbVersion = activeHostProfile?.lastRemoteDbVersion ?? 0
    remoteCommandDescriptors = loadRemoteCommandDescriptors()
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
        isExpensive: path.isExpensive
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
    ) { [weak self] _ in
      guard let self else { return }
      Task { @MainActor in
        self.scheduleLocalStateRevisionBumpAfterDatabaseChange()
      }
    }
    socketSessionDelegate.service = self

    // Publish this instance as the singleton consumed by AppDelegate and the
    // LiveActivityIntentsForward entry points. Tests that need an isolated
    // instance may overwrite it after init.
    Self.shared = self

    if #available(iOS 16.2, *) {
      liveActivityCoordinator = LiveActivityCoordinator(host: self)
    }
    refreshActiveSessionsAndSnapshot()
  }

  deinit {
    databaseRevisionDebounceTask?.cancel()
    relayTask?.cancel()
    hydrationTask?.cancel()
    projectSelectionTask?.cancel()
    reconnectTask?.cancel()
    networkPathReconnectTask?.cancel()
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

  private func scheduleLocalStateRevisionBumpAfterDatabaseChange() {
    databaseRevisionDebounceTask?.cancel()
    databaseRevisionDebounceTask = Task { @MainActor [weak self] in
      guard let self else { return }
      try? await Task.sleep(nanoseconds: 280_000_000)
      guard !Task.isCancelled else { return }
      self.refreshProjectCatalog()
      localStateRevision += 1
      self.refreshActiveSessionsAndSnapshot()
    }
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
      upsertKnownProfile(profile)
      return profile
    }
    guard let data = UserDefaults.standard.data(forKey: legacyDraftKey),
          let draft = try? decoder.decode(ConnectionDraft.self, from: data) else {
      return nil
    }
    let migrated = HostConnectionProfile(legacy: draft)
    saveProfile(migrated)
    UserDefaults.standard.removeObject(forKey: legacyDraftKey)
    return migrated
  }

  private func profileStorageKey(_ profile: HostConnectionProfile) -> String? {
    if let identity = profile.hostIdentity?.trimmingCharacters(in: .whitespacesAndNewlines), !identity.isEmpty {
      return "device:\(identity.lowercased())"
    }
    if let lastSuccessfulAddress = profile.lastSuccessfulAddress,
       let host = syncEndpointHost(lastSuccessfulAddress)?.lowercased(),
       !host.isEmpty {
      return "route:\(host):\(profile.port)"
    }
    if let hostName = profile.hostName?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), !hostName.isEmpty {
      return "name:\(hostName):\(profile.port)"
    }
    return nil
  }

  private func loadKnownProfiles() -> [HostConnectionProfile] {
    guard let data = UserDefaults.standard.data(forKey: profilesKey),
          let profiles = try? decoder.decode([HostConnectionProfile].self, from: data) else {
      return []
    }
    return deduplicatedProfiles(profiles)
  }

  private func saveKnownProfiles(_ profiles: [HostConnectionProfile]) {
    let normalized = deduplicatedProfiles(profiles)
    if normalized.isEmpty {
      UserDefaults.standard.removeObject(forKey: profilesKey)
      return
    }
    if let data = try? encoder.encode(normalized) {
      UserDefaults.standard.set(data, forKey: profilesKey)
    }
  }

  private func deduplicatedProfiles(_ profiles: [HostConnectionProfile]) -> [HostConnectionProfile] {
    var byKey: [String: HostConnectionProfile] = [:]
    var anonymous: [HostConnectionProfile] = []
    for profile in profiles {
      guard let key = profileStorageKey(profile) else {
        anonymous.append(profile)
        continue
      }
      if let existing = byKey[key] {
        byKey[key] = shouldPreferProfile(profile, over: existing) ? profile : existing
      } else {
        byKey[key] = profile
      }
    }
    return (Array(byKey.values) + anonymous).sorted { left, right in
      left.updatedAt > right.updatedAt
    }
  }

  private func shouldPreferProfile(_ candidate: HostConnectionProfile, over existing: HostConnectionProfile) -> Bool {
    if candidate.updatedAt != existing.updatedAt {
      return candidate.updatedAt > existing.updatedAt
    }
    if candidate.tailscaleAddress != nil && existing.tailscaleAddress == nil {
      return true
    }
    return candidate.lastSuccessfulAddress != nil && existing.lastSuccessfulAddress == nil
  }

  private func upsertKnownProfile(_ profile: HostConnectionProfile) {
    guard let key = profileStorageKey(profile) else { return }
    let existing = loadKnownProfiles().filter { profileStorageKey($0) != key }
    saveKnownProfiles([profile] + existing)
    if let token = keychain.loadToken() {
      keychain.saveToken(token, forHostKey: key)
    }
  }

  private func removeKnownProfile(_ profile: HostConnectionProfile) {
    guard let key = profileStorageKey(profile) else { return }
    saveKnownProfiles(loadKnownProfiles().filter { profileStorageKey($0) != key })
    keychain.clearToken(forHostKey: key)
  }

  private func token(for profile: HostConnectionProfile) -> String? {
    if let key = profileStorageKey(profile),
       let token = keychain.loadToken(forHostKey: key) {
      return token
    }
    if let activeHostProfile, profile == activeHostProfile {
      return keychain.loadToken()
    }
    return nil
  }

  private func publishMergedDiscoveredHosts() {
    applyDiscoveredHosts(bonjourDiscoveredHosts + tailnetDiscoveredHosts)
  }

  var canReconnectToSavedHost: Bool {
    guard let profile = activeHostProfile else { return false }
    return token(for: profile) != nil
  }

  var savedReconnectHost: DiscoveredSyncHost? {
    savedReconnectHosts.first
  }

  var savedReconnectHosts: [DiscoveredSyncHost] {
    loadKnownProfiles()
      .filter { token(for: $0) != nil }
      .compactMap { savedReconnectHost(for: $0) }
  }

  private func savedReconnectHost(for profile: HostConnectionProfile) -> DiscoveredSyncHost? {
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
    return DiscoveredSyncHost(
      id: "saved-\(identity?.isEmpty == false ? identity! : routeId)",
      serviceName: "Saved ADE host",
      hostName: displayName?.isEmpty == false ? displayName! : routeId,
      hostIdentity: identity?.isEmpty == false ? identity : nil,
      port: profile.port,
      addresses: addresses,
      tailscaleAddress: tailscaleAddress,
      lastResolvedAt: profile.updatedAt
    )
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
    guard userInitiated || allowAutoReconnect else {
      syncConnectLog.info("reconnect skipped: automatic reconnect disabled")
      return
    }
    guard userInitiated || !autoReconnectPausedByUser else {
      syncConnectLog.info("reconnect skipped: paused by user")
      return
    }
    allowAutoReconnect = true
    guard let profile = loadProfile(), let token = token(for: profile) else { return }
    keychain.saveToken(token)
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

  func reconnectToSavedHost(_ host: DiscoveredSyncHost, preferTailnet: Bool = false) async {
    guard let profile = profile(forSavedHost: host), let token = token(for: profile) else {
      lastError = "That saved host is missing pairing credentials. Pair it again from Settings."
      connectionState = .error
      return
    }
    keychain.saveToken(token)
    saveProfile(profile)
    await reconnectIfPossible(userInitiated: true, preferTailnet: preferTailnet || host.tailscaleAddress != nil)
  }

  private func profile(forSavedHost host: DiscoveredSyncHost) -> HostConnectionProfile? {
    let normalizedHostId = host.hostIdentity?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let hostAddresses = Set((host.addresses + (host.tailscaleAddress.map { [$0] } ?? [])).map(syncNormalizedRouteHost))
    return loadKnownProfiles().first { profile in
      if let normalizedHostId,
         let profileIdentity = profile.hostIdentity?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
         profileIdentity == normalizedHostId {
        return true
      }
      let profileAddresses = Set(
        (profile.savedAddressCandidates
         + profile.discoveredLanAddresses
         + (profile.lastSuccessfulAddress.map { [$0] } ?? [])
         + (profile.tailscaleAddress.map { [$0] } ?? []))
          .map(syncNormalizedRouteHost)
      )
      return !profileAddresses.isDisjoint(with: hostAddresses)
    }
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

  private func handleNetworkPathChange(_ snapshot: SyncNetworkPathSnapshot) {
    let previous = lastNetworkPathSnapshot
    lastNetworkPathSnapshot = snapshot
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
    networkPathReconnectTask?.cancel()
    networkPathReconnectTask = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: delayNanoseconds)
      guard let self, !Task.isCancelled else { return }
      if forceSocketReset {
        self.teardownSocket(reason: "Network route changed.")
      }
      await self.reconnectIfPossible()
    }
  }

  func handleForegroundTransition() async {
    guard !reconnectConnectInFlight else { return }
    if canSendLiveRequests() {
      do {
        try await refreshLaneSnapshots()
        try await refreshWorkSessions()
        try await refreshPullRequestSnapshots()
        lastError = nil
      } catch {
        lastError = SyncUserFacingError.message(for: error)
      }
      return
    }

    await reconnectIfPossible()
  }

  func pairAndConnect(
    host: String,
    port: Int,
    code: String,
    hostIdentity: String? = nil,
    hostName: String? = nil,
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
    let connectAttemptGeneration: UInt64
    do {
      cancelReconnectLoop()
      allowAutoReconnect = false
      setAutoReconnectPausedByUser(false)
      disconnect(clearCredentials: false, suspendAutoReconnect: false)
      connectAttemptGeneration = beginConnectAttempt()
      resetChatEventState(clearHistory: true)
      let endpoint = syncParseRouteEndpoint(host)
      let requestedHost = endpoint?.host ?? host.trimmingCharacters(in: .whitespacesAndNewlines)
      let requestedPort = endpoint?.port ?? port
      let normalizedCandidateAddresses = candidateAddresses.compactMap { syncEndpointHost($0) }
      let normalizedTailscaleAddress = tailscaleAddress.flatMap(syncEndpointHost)
      let matchingDiscovery = discoveredHosts.filter { discovered in
        if let hostIdentity, !hostIdentity.isEmpty {
          return discovered.hostIdentity == hostIdentity
        }
        if let hostName, !hostName.isEmpty {
          return discovered.hostName.localizedCaseInsensitiveCompare(hostName) == .orderedSame
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
      for candidate in addressCandidates {
        guard isCurrentConnectAttempt(connectAttemptGeneration) else {
          throw CancellationError()
        }
        let kind = addressCandidateKind(candidate, profile: nil, explicitTailscaleAddress: normalizedTailscaleAddress)
        for candidatePort in portCandidates {
          syncConnectLog.info("ADE_SYNC_TRACE pair attempt host=\(candidate, privacy: .public) port=\(candidatePort) kind=\(kind, privacy: .public)")
          do {
            try await openSocket(
              host: candidate,
              port: candidatePort,
              connectAttemptGeneration: connectAttemptGeneration
            )
            syncConnectLog.info("ADE_SYNC_TRACE pair success host=\(candidate, privacy: .public) port=\(candidatePort)")
            openedAddress = candidate
            openedPort = candidatePort
            break
          } catch {
            syncConnectLog.info("ADE_SYNC_TRACE pair failure host=\(candidate, privacy: .public) port=\(candidatePort) error=\(syncLogErrorSummary(error), privacy: .public)")
            lastOpenError = error
            teardownSocket()
            continue
          }
        }
        if openedAddress != nil {
          break
        }
      }
      guard let preferredAddress = openedAddress, let preferredPort = openedPort else {
        throw lastOpenError ?? NSError(domain: "ADE", code: 19, userInfo: [NSLocalizedDescriptionKey: "Unable to reach the host."])
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
        throw NSError(domain: "ADE", code: 2, userInfo: [
          NSLocalizedDescriptionKey: friendlyPairingFailureMessage(raw)
        ])
      }
      guard let secret = payload["secret"] as? String else {
        throw NSError(domain: "ADE", code: 3, userInfo: [NSLocalizedDescriptionKey: "Pairing secret missing from response."])
      }
      let pairedDeviceId = payload["deviceId"] as? String ?? deviceId
      keychain.saveToken(secret)
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
    } catch {
      guard isCurrentConnectAttempt(connectAttemptGeneration) else { return }
      let friendlyMessage = SyncUserFacingError.message(for: error)
      cancelReconnectLoop()
      allowAutoReconnect = false
      setAutoReconnectPausedByUser(true)
      teardownSocket(reason: friendlyMessage)
      lastError = friendlyMessage
      connectionState = .error
      setDomainStatus(SyncDomain.allCases, phase: .failed, error: friendlyMessage)
    }
  }

  func decodePairingQrPayload(from rawValue: String) throws -> SyncPairingQrPayload {
    let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
    if let url = URL(string: trimmed), let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
       let payloadValue = components.queryItems?.first(where: { $0.name == "payload" })?.value {
      let json = payloadValue.removingPercentEncoding ?? payloadValue
      if let data = json.data(using: .utf8), let payload = try? decodeCurrentPairingQrPayload(from: data) {
        return payload
      }
    }

    throw NSError(domain: "ADE", code: 22, userInfo: [NSLocalizedDescriptionKey: "That QR code is not a valid ADE pairing payload."])
  }

  private func decodeCurrentPairingQrPayload(from data: Data) throws -> SyncPairingQrPayload {
    let payload = try decoder.decode(SyncPairingQrPayload.self, from: data)
    guard payload.version == 2 else {
      throw NSError(
        domain: "ADE",
        code: 22,
        userInfo: [NSLocalizedDescriptionKey: "That QR code uses an unsupported ADE pairing format."]
      )
    }
    return payload
  }

  private func friendlyPairingFailureMessage(_ raw: Any) -> String {
    let error = (raw as? [String: Any])?["error"] as? [String: Any]
    let code = error?["code"] as? String
    let message = error?["message"] as? String

    switch code {
    case "invalid_pin":
      return "Incorrect PIN."
    case "pin_not_set":
      return "No PIN set on that computer. Set one in the desktop app's Sync settings."
    default:
      return message ?? "Pairing failed."
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
    reconnectTask?.cancel()
    teardownSocket(closeCode: .normalClosure)
    connectionState = .disconnected
    hostName = activeHostProfile?.hostName
    latestRemoteDbVersion = 0
    outboundLocalDbVersion = database.currentDbVersion()
    setDomainStatus(SyncDomain.allCases, phase: .disconnected)
    if clearCredentials {
      if let profile = activeHostProfile {
        removeKnownProfile(profile)
      }
      keychain.clearToken()
      saveProfile(nil)
      saveRemoteCommandDescriptors([])
      resetChatEventState(clearHistory: true)
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

  func refreshLaneSnapshots() async throws {
    setDomainStatus([.lanes, .files], phase: .hydrating)
    do {
      let raw = try await sendCommand(action: "lanes.refreshSnapshots", args: [
        "includeArchived": true,
        "includeStatus": true,
      ])
      let payload = try decodeHydrationPayload(raw, as: LaneRefreshPayload.self, domainLabel: "lane", decoder: decoder)
      try database.replaceLaneSnapshots(payload.lanes, snapshots: payload.snapshots)
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

  func fetchAgentCoreMemory(agentId: String) async throws -> AgentCoreMemory {
    try await sendDecodableCommand(
      action: "cto.getAgentCoreMemory",
      args: ["agentId": agentId],
      as: AgentCoreMemory.self
    )
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

  func fetchLinearSyncDashboard() async throws -> LinearSyncDashboard {
    try await sendDecodableCommand(action: "cto.getLinearSyncDashboard", as: LinearSyncDashboard.self)
  }

  func runLinearSyncNow() async throws -> LinearSyncDashboard {
    try await sendDecodableCommand(action: "cto.runLinearSyncNow", as: LinearSyncDashboard.self)
  }

  func removeAgent(agentId: String) async throws {
    _ = try await sendCommand(action: "cto.removeAgent", args: ["agentId": agentId])
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

  func updateCtoCoreMemory(patch: CtoCoreMemoryPatch) async throws -> CtoSnapshot {
    let patchArgs = try encodedCommandArgs(from: patch)
    return try await sendDecodableCommand(
      action: "cto.updateCoreMemory",
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
      try database.replacePullRequestHydration(payload)
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
    setDomainStatus([.lanes], phase: .hydrating)
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

  var runningChatSessionCount: Int {
    database.fetchSessions().filter { session in
      session.status == "running" && (session.toolType?.contains("chat") == true)
    }.count
  }

  func fetchComputerUseArtifacts(ownerKind: String, ownerId: String) async throws -> [ComputerUseArtifactSummary] {
    database.fetchComputerUseArtifacts(ownerKind: ownerKind, ownerId: ownerId)
  }

  func renameSession(sessionId: String, title: String) async throws {
    try database.updateSessionTitle(sessionId: sessionId, title: title)
  }

  func setSessionPinned(sessionId: String, pinned: Bool) async throws {
    if supportsRemoteAction("work.updateSessionMeta") {
      _ = try await sendCommand(action: "work.updateSessionMeta", args: [
        "sessionId": sessionId,
        "pinned": pinned,
      ])
    }
    try database.setSessionPinned(sessionId: sessionId, pinned: pinned)
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
    if supportsRemoteAction("work.updateSessionMeta") {
      _ = try await sendCommand(action: "work.updateSessionMeta", args: args)
    }
    if let title {
      try database.updateSessionTitle(sessionId: sessionId, title: title)
    }
    if let pinned {
      try database.setSessionPinned(sessionId: sessionId, pinned: pinned)
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

  func fetchGitHubPullRequestSnapshot(force: Bool = false) async throws -> GitHubPrSnapshot {
    try await sendDecodableCommand(action: "prs.getGitHubSnapshot", args: ["force": force], as: GitHubPrSnapshot.self)
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
      throw NSError(domain: "ADE", code: 119, userInfo: [NSLocalizedDescriptionKey: "Files stays read-only on iPhone for this mission."])
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

  func quickOpen(workspaceId: String, query: String) async throws -> [FilesQuickOpenItem] {
    try decode(
      try await sendFileRequest(action: "quickOpen", args: ["workspaceId": workspaceId, "query": query]),
      as: [FilesQuickOpenItem].self
    )
  }

  func searchText(workspaceId: String, query: String) async throws -> [FilesSearchTextMatch] {
    try decode(
      try await sendFileRequest(action: "searchText", args: ["workspaceId": workspaceId, "query": query]),
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
    let requestId = makeRequestId()
    let raw = try await awaitResponse(requestId: requestId) {
      self.sendEnvelope(type: "terminal_subscribe", requestId: requestId, payload: [
        "sessionId": sessionId,
        "maxBytes": syncTerminalSubscriptionMaxBytes,
      ])
    }
    let snapshot = try decode(raw, as: TerminalSnapshot.self)
    terminalBuffers[sessionId] = trimmedTerminalBuffer(snapshot.transcript)
    markTerminalBufferChanged(immediate: true)
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

  func subscribeToChatEvents(sessionId: String) async throws {
    let trimmedSessionId = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedSessionId.isEmpty else { return }
    guard !subscribedChatSessionIds.contains(trimmedSessionId) else { return }
    subscribedChatSessionIds.insert(trimmedSessionId)
    localStateRevision += 1
    if canSendLiveRequests() && supportsChatStreaming {
      sendEnvelope(type: "chat_subscribe", requestId: nil, payload: chatSubscriptionPayload(sessionId: trimmedSessionId))
    }
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

  func chatEventRevision(for sessionId: String) -> Int {
    chatEventRevisionsBySession[sessionId] ?? 0
  }

  func chatSubscriptionPayloads() -> [[String: Any]] {
    subscribedChatSessionIds.sorted().map { chatSubscriptionPayload(sessionId: $0) }
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

  func closeWorkSession(sessionId: String) async throws {
    _ = try await sendCommand(action: "work.closeSession", args: ["sessionId": sessionId])
  }

  func createLane(
    name: String,
    description: String,
    parentLaneId: String? = nil,
    baseBranch: String? = nil
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
    return try await sendDecodableCommand(action: "lanes.create", args: args, as: LaneSummary.self)
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

  func createChildLane(name: String, parentLaneId: String, description: String = "", folder: String? = nil) async throws -> LaneSummary {
    var args: [String: Any] = [
      "name": name,
      "parentLaneId": parentLaneId,
      "description": description,
    ]
    if let folder, !folder.isEmpty {
      args["folder"] = folder
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

  func reparentLane(_ laneId: String, newParentLaneId: String?) async throws {
    var args: [String: Any] = ["laneId": laneId]
    // Always include the key so the server receives a defined value.
    // "ROOT" signals detachment from any parent lane.
    args["newParentLaneId"] = (newParentLaneId?.isEmpty == false) ? newParentLaneId! : "ROOT"
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

  func checkoutPrimaryBranch(laneId: String, branchName: String) async throws {
    _ = try await sendCommand(action: "git.checkoutBranch", args: ["laneId": laneId, "branchName": branchName])
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

  func listChatModels(provider: String) async throws -> [AgentChatModelInfo] {
    try await sendDecodableCommand(action: "chat.models", args: ["provider": provider], as: [AgentChatModelInfo].self)
  }

  func listChatSessions(laneId: String) async throws -> [AgentChatSessionSummary] {
    try await sendDecodableCommand(action: "chat.listSessions", args: ["laneId": laneId, "includeAutomation": true], as: [AgentChatSessionSummary].self)
  }

  func createChatSession(
    laneId: String,
    provider: String,
    model: String = "",
    reasoningEffort: String? = nil,
    sessionProfile: String? = nil,
    permissionMode: String? = nil,
    interactionMode: String? = nil,
    claudePermissionMode: String? = nil,
    codexApprovalPolicy: String? = nil,
    codexSandbox: String? = nil,
    codexConfigSource: String? = nil,
    opencodePermissionMode: String? = nil,
    cursorModeId: String? = nil,
    cursorConfigValues: [String: RemoteJSONValue]? = nil,
    computerUse: RemoteJSONValue? = nil,
    requestedCwd: String? = nil
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
    return try await sendDecodableCommand(action: "chat.create", args: args, as: AgentChatSessionSummary.self)
  }

  func fetchChatSummary(sessionId: String) async throws -> AgentChatSessionSummary {
    try await sendDecodableCommand(action: "chat.getSummary", args: ["sessionId": sessionId], as: AgentChatSessionSummary.self)
  }

  func fetchChatTranscriptResponse(sessionId: String, limit: Int = 200, maxChars: Int = 32_000) async throws -> AgentChatTranscriptResponse {
    try await sendDecodableCommand(
      action: "chat.getTranscript",
      args: ["sessionId": sessionId, "limit": limit, "maxChars": maxChars],
      as: AgentChatTranscriptResponse.self
    )
  }

  func fetchChatTranscript(sessionId: String, limit: Int = 200, maxChars: Int = 32_000) async throws -> [AgentChatTranscriptEntry] {
    let response = try await fetchChatTranscriptResponse(sessionId: sessionId, limit: limit, maxChars: maxChars)
    return response.entries
  }

  func sendChatMessage(sessionId: String, text: String) async throws {
    _ = try await sendCommand(action: "chat.send", args: ["sessionId": sessionId, "text": text])
  }

  func interruptChatSession(sessionId: String) async throws {
    _ = try await sendChatCommand(action: "chat.interrupt", payload: AgentChatInterruptRequest(sessionId: sessionId))
  }

  func steerChatSession(sessionId: String, text: String) async throws {
    _ = try await sendChatCommand(action: "chat.steer", payload: AgentChatSteerRequest(sessionId: sessionId, text: text))
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

  func resumeChatSession(sessionId: String) async throws -> AgentChatSession {
    try await sendDecodableChatCommand(
      action: "chat.resume",
      payload: AgentChatResumeRequest(sessionId: sessionId),
      as: AgentChatSession.self
    )
  }

  func updateChatSession(
    sessionId: String,
    title: String? = nil,
    modelId: String? = nil,
    reasoningEffort: String? = nil,
    permissionMode: String? = nil,
    interactionMode: String? = nil,
    claudePermissionMode: String? = nil,
    codexApprovalPolicy: String? = nil,
    codexSandbox: String? = nil,
    codexConfigSource: String? = nil,
    opencodePermissionMode: String? = nil,
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
        permissionMode: permissionMode,
        interactionMode: interactionMode,
        claudePermissionMode: claudePermissionMode,
        codexApprovalPolicy: codexApprovalPolicy,
        codexSandbox: codexSandbox,
        codexConfigSource: codexConfigSource,
        opencodePermissionMode: opencodePermissionMode,
        cursorModeId: cursorModeId,
        cursorConfigValues: cursorConfigValues,
        unifiedPermissionMode: unifiedPermissionMode,
        computerUse: computerUse,
        manuallyNamed: manuallyNamed
      ),
      as: AgentChatSession.self
    )
  }

  func disposeChatSession(sessionId: String) async throws {
    _ = try await sendChatCommand(action: "chat.dispose", payload: AgentChatDisposeRequest(sessionId: sessionId))
  }

  func archiveChatSession(sessionId: String) async throws {
    _ = try await sendChatCommand(action: "chat.archive", payload: AgentChatDisposeRequest(sessionId: sessionId))
  }

  func unarchiveChatSession(sessionId: String) async throws {
    _ = try await sendChatCommand(action: "chat.unarchive", payload: AgentChatDisposeRequest(sessionId: sessionId))
  }

  func deleteChatSession(sessionId: String) async throws {
    _ = try await sendChatCommand(action: "chat.delete", payload: AgentChatDisposeRequest(sessionId: sessionId))
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

  func mergePullRequest(prId: String, method: String) async throws {
    _ = try await sendCommand(action: "prs.land", args: [
      "prId": prId,
      "method": method,
    ])
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

  @discardableResult
  func startPrAiResolution(prId: String, model: String? = nil, reasoningEffort: String? = nil) async throws -> AiResolutionState {
    var args: [String: Any] = ["prId": prId]
    if let model, !model.isEmpty {
      args["model"] = model
    }
    if let reasoningEffort, !reasoningEffort.isEmpty {
      args["reasoningEffort"] = reasoningEffort
    }
    return try await sendDecodableCommand(action: "prs.aiResolutionStart", args: args, as: AiResolutionState.self)
  }

  func stopPrAiResolution(prId: String) async throws {
    _ = try await sendCommand(action: "prs.aiResolutionStop", args: ["prId": prId])
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

  func syncIssueInventory(prId: String) async throws -> IssueInventorySnapshot {
    try await sendDecodableCommand(action: "prs.issueInventory.sync", args: ["prId": prId], as: IssueInventorySnapshot.self)
  }

  func fetchIssueInventory(prId: String) async throws -> IssueInventorySnapshot {
    try await sendDecodableCommand(action: "prs.issueInventory.get", args: ["prId": prId], as: IssueInventorySnapshot.self)
  }

  func markIssueInventoryFixed(prId: String, itemIds: [String]) async throws {
    _ = try await sendCommand(action: "prs.issueInventory.markFixed", args: ["prId": prId, "itemIds": itemIds])
  }

  func markIssueInventoryDismissed(prId: String, itemIds: [String], reason: String) async throws {
    _ = try await sendCommand(action: "prs.issueInventory.markDismissed", args: [
      "prId": prId,
      "itemIds": itemIds,
      "reason": reason,
    ])
  }

  func markIssueInventoryEscalated(prId: String, itemIds: [String]) async throws {
    _ = try await sendCommand(action: "prs.issueInventory.markEscalated", args: ["prId": prId, "itemIds": itemIds])
  }

  func resetIssueInventory(prId: String) async throws {
    _ = try await sendCommand(action: "prs.issueInventory.reset", args: ["prId": prId])
  }

  func fetchPipelineSettings(prId: String) async throws -> PipelineSettings {
    // Delegate to `getPipelineSettings` so both paths handle the server's
    // `NSNull` response uniformly instead of crashing with a decode error
    // when the desktop returns "no settings" after a save.
    if let settings = try await getPipelineSettings(prId: prId) {
      return settings
    }
    return PipelineSettings(autoMerge: false, mergeMethod: "repo_default", maxRounds: 5, onRebaseNeeded: "pause")
  }

  func savePipelineSettings(prId: String, autoMerge: Bool? = nil, mergeMethod: String? = nil, maxRounds: Int? = nil, onRebaseNeeded: String? = nil) async throws {
    var settings: [String: Any] = [:]
    if let autoMerge { settings["autoMerge"] = autoMerge }
    if let mergeMethod { settings["mergeMethod"] = mergeMethod }
    if let maxRounds { settings["maxRounds"] = maxRounds }
    if let onRebaseNeeded { settings["onRebaseNeeded"] = onRebaseNeeded }
    _ = try await sendCommand(action: "prs.pipelineSettings.save", args: ["prId": prId, "settings": settings])
  }

  func savePipelineSettings(prId: String, settings: PipelineSettings) async throws {
    _ = try await sendCommand(action: "prs.pipelineSettings.save", args: [
      "prId": prId,
      "settings": [
        "autoMerge": settings.autoMerge,
        "mergeMethod": settings.mergeMethod,
        "maxRounds": settings.maxRounds,
        "onRebaseNeeded": settings.onRebaseNeeded,
      ],
    ])
  }

  func getPipelineSettings(prId: String) async throws -> PipelineSettings? {
    let response = try await sendCommand(action: "prs.pipelineSettings.get", args: ["prId": prId])
    if response is NSNull { return nil }
    if let payload = response as? [String: Any], payload["queued"] as? Bool == true {
      throw QueuedRemoteCommandError(action: "prs.pipelineSettings.get")
    }
    return try decode(response, as: PipelineSettings.self)
  }

  func deletePipelineSettings(prId: String) async throws {
    _ = try await sendCommand(action: "prs.pipelineSettings.delete", args: ["prId": prId])
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
      activeHostProfile = profile
      hostName = profile.hostName
      upsertKnownProfile(profile)
    } else {
      UserDefaults.standard.removeObject(forKey: profileKey)
      UserDefaults.standard.removeObject(forKey: legacyDraftKey)
      activeHostProfile = nil
      hostName = nil
    }
  }

  private func updateProfile(_ transform: (inout HostConnectionProfile) -> Void) {
    guard var profile = loadProfile() else { return }
    transform(&profile)
    profile.updatedAt = ISO8601DateFormatter().string(from: Date())
    saveProfile(profile)
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

  private func commandDescriptor(for action: String) -> SyncRemoteCommandDescriptor? {
    remoteCommandDescriptors.first(where: { $0.action == action })
  }

  private func commandPolicy(for action: String) -> SyncRemoteCommandPolicy? {
    commandDescriptor(for: action)?.policy
  }

  func supportsRemoteAction(_ action: String) -> Bool {
    commandDescriptor(for: action) != nil
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
        timeoutMessage: "The host did not acknowledge lane presence in time."
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
    var seen = Set<String>()
    return addresses
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
        NSLocalizedDescriptionKey: "No ADE host address is available. Scan the pairing QR again or enter the host address manually.",
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

    if let tailnetService = discovered.tailscaleAddress,
       syncIsTailnetDiscoveryHost(tailnetService),
       profileHasTailnetRoute(profile) {
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

  private func profileHasTailnetRoute(_ profile: HostConnectionProfile) -> Bool {
    if profile.tailscaleAddress.map(syncIsTailscaleRoute) == true { return true }
    if profile.lastSuccessfulAddress.map(syncIsTailscaleRoute) == true { return true }
    return profile.savedAddressCandidates.contains(where: syncIsTailscaleRoute)
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
    let preferTailnet = shouldPreferTailnetReconnect()
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
    let portCandidates = syncConnectPortCandidates(primaryPort: profile.port, addresses: addresses)
    syncConnectLog.info(
      "ADE_SYNC_TRACE reconnect candidates preferLiveOnly=\(preferLiveCandidatesOnly) path=\(syncLogPathSummary(self.lastNetworkPathSnapshot), privacy: .public) profile=\(syncLogProfileSummary(profile), privacy: .public) raw=[\(syncLogAddressList(rawAddresses), privacy: .public)] ports=[\(portCandidates.map(String.init).joined(separator: ","), privacy: .public)] connectable=[\(syncLogAddressList(addresses), privacy: .public)]"
    )
    guard !addresses.isEmpty else {
      if rawAddresses.isEmpty {
        throw NSError(domain: "ADE", code: 18, userInfo: [NSLocalizedDescriptionKey: "No saved address is available for this host."])
      }
      throw noConnectableAddressError()
    }

    for address in addresses {
      guard isCurrentConnectAttempt(connectAttemptGeneration) else {
        throw CancellationError()
      }
      let kind = addressCandidateKind(address, profile: profile, explicitTailscaleAddress: nil)
      for candidatePort in portCandidates {
        syncConnectLog.info("ADE_SYNC_TRACE reconnect attempt host=\(address, privacy: .public) port=\(candidatePort) kind=\(kind, privacy: .public)")
        do {
          try await openSocket(
            host: address,
            port: candidatePort,
            connectAttemptGeneration: connectAttemptGeneration,
            publishConnecting: publishConnecting
          )
          try await hello(
            host: address,
            port: candidatePort,
            token: token,
            authKind: profile.authKind,
            pairedDeviceId: profile.pairedDeviceId,
            expectedHostIdentity: profile.hostIdentity,
            connectAttemptGeneration: connectAttemptGeneration
          )
          guard isCurrentConnectAttempt(connectAttemptGeneration) else {
            throw CancellationError()
          }
          syncConnectLog.info("ADE_SYNC_TRACE reconnect success host=\(address, privacy: .public) port=\(candidatePort)")
          return (host: address, port: candidatePort)
        } catch {
          syncConnectLog.info("ADE_SYNC_TRACE reconnect failure host=\(address, privacy: .public) port=\(candidatePort) error=\(syncLogErrorSummary(error), privacy: .public)")
          lastFailure = error
          if shouldInvalidateSavedPairing(for: error) {
            forgetHost()
            throw error
          }
          // Tear down this attempt's socket and keep iterating through the
          // remaining ports and addresses. Only surface an error if every
          // candidate fails.
          teardownSocket()
          continue
        }
      }
    }

    throw lastFailure ?? NSError(domain: "ADE", code: 19, userInfo: [NSLocalizedDescriptionKey: "Unable to reach the saved ADE host."])
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
    guard allowAutoReconnect,
          !autoReconnectPausedByUser,
          let profile = loadProfile(),
          token(for: profile) != nil else { return }
    reconnectTask?.cancel()
    reconnectTask = Task { @MainActor in
      try? await Task.sleep(nanoseconds: delayNanoseconds)
      guard !Task.isCancelled else { return }
      await reconnectIfPossible()
    }
  }

  private func cancelReconnectLoop() {
    reconnectState.reset()
    reconnectTask?.cancel()
    reconnectTask = nil
  }

  private func shouldInvalidateSavedPairing(for error: Error) -> Bool {
    let nsError = error as NSError
    return nsError.userInfo["ADEErrorCode"] as? String == "auth_failed"
  }

  private func applyDiscoveredHosts(_ hosts: [DiscoveredSyncHost]) {
    var mergedByIdentity: [String: DiscoveredSyncHost] = [:]
    var noIdentity: [DiscoveredSyncHost] = []
    for host in hosts {
      guard let identity = host.hostIdentity?.trimmingCharacters(in: .whitespacesAndNewlines), !identity.isEmpty else {
        noIdentity.append(host)
        continue
      }
      if let existing = mergedByIdentity[identity] {
        let preferred = host.lastResolvedAt >= existing.lastResolvedAt ? host : existing
        let fallback = host.lastResolvedAt >= existing.lastResolvedAt ? existing : host
        let addresses = deduplicatedAddresses(preferred.addresses + fallback.addresses)
        let tailscale = preferred.tailscaleAddress ?? fallback.tailscaleAddress
        let port = preferred.port > 0 ? preferred.port : fallback.port
        let mergedName = preferred.hostName.isEmpty ? fallback.hostName : preferred.hostName
        mergedByIdentity[identity] = DiscoveredSyncHost(
          id: identity,
          serviceName: existing.serviceName,
          hostName: mergedName,
          hostIdentity: identity,
          port: port,
          addresses: addresses,
          tailscaleAddress: tailscale,
          lastResolvedAt: host.lastResolvedAt > existing.lastResolvedAt ? host.lastResolvedAt : existing.lastResolvedAt
        )
      } else {
        var tagged = host
        tagged.id = identity
        mergedByIdentity[identity] = tagged
      }
    }
    let identifiedHosts = Array(mergedByIdentity.values)
    let filteredNoIdentity = noIdentity.filter { host in
      !shouldSuppressAnonymousTailnetHost(host, identifiedHosts: identifiedHosts)
    }
    let merged = identifiedHosts + filteredNoIdentity
    discoveredHosts = merged.sorted { $0.hostName.localizedCaseInsensitiveCompare($1.hostName) == .orderedAscending }
    guard let profile = activeHostProfile else { return }
    let matching = discoveredHosts.filter { discovered in
      matchesDiscoveredHost(discovered, profile: profile)
    }
    guard !matching.isEmpty else { return }
    updateProfile { profile in
      let liveLanAddresses = deduplicatedAddresses(matching.flatMap(\.addresses))
      let liveTailscaleAddress = matching.compactMap(\.tailscaleAddress).first ?? profile.tailscaleAddress
      profile.discoveredLanAddresses = liveLanAddresses
      profile.tailscaleAddress = liveTailscaleAddress
      profile.savedAddressCandidates = Array(
        deduplicatedAddresses(
          (profile.lastSuccessfulAddress.map { [$0] } ?? [])
          + liveLanAddresses
          + (liveTailscaleAddress.map { [$0] } ?? [])
        ).prefix(6)
      )
      if profile.hostIdentity == nil {
        profile.hostIdentity = matching.compactMap(\.hostIdentity).first
      }
      if profile.hostName == nil {
        profile.hostName = matching.first?.hostName
      }
    }
    guard autoReconnectAwaitingLiveDiscovery,
          allowAutoReconnect,
          !autoReconnectPausedByUser,
          !reconnectConnectInFlight,
          !canSendLiveRequests(),
          let refreshedProfile = activeHostProfile,
          token(for: refreshedProfile) != nil,
          !automaticReconnectAddresses(for: refreshedProfile).isEmpty else {
      return
    }
    autoReconnectAwaitingLiveDiscovery = false
    Task { @MainActor [weak self] in
      await self?.reconnectIfPossible()
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
    [
      "deviceId": deviceId,
      "deviceName": UIDevice.current.name,
      "platform": "iOS",
      "deviceType": "phone",
      "siteId": database.localSiteId(),
      "dbVersion": latestRemoteDbVersion,
    ]
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
    }

    guard let urlString = syncWebSocketURLString(host: socketHost, port: socketPort),
          let url = URL(string: urlString) else {
      throw NSError(domain: "ADE", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid host address."])
    }
    let task = socketSession.webSocketTask(with: url)
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
    refreshProjectCatalog()
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
    if let expectedHostIdentity, let remoteHostIdentity, expectedHostIdentity != remoteHostIdentity {
      disconnect(clearCredentials: false)
      remoteProjectCatalog = []
      refreshProjectCatalog()
      throw NSError(
        domain: "ADE",
        code: 20,
        userInfo: [NSLocalizedDescriptionKey: "The saved pairing belongs to a different ADE host. Pair again with the current host."]
      )
    }

    let features = payload["features"] as? [String: Any]
    supportsChatStreaming = {
      if let chatStreaming = features?["chatStreaming"] as? [String: Any],
         let enabled = chatStreaming["enabled"] as? Bool {
        return enabled
      }
      if let value = features?["chatStreaming"] as? Bool {
        return value
      }
      if let chatStreaming = features?["chat_streaming"] as? [String: Any],
         let enabled = chatStreaming["enabled"] as? Bool {
        return enabled
      }
      if let value = features?["chat_streaming"] as? Bool {
        return value
      }
      return false
    }()
    supportsProjectCatalog = {
      if let projectCatalog = features?["projectCatalog"] as? [String: Any],
         let enabled = projectCatalog["enabled"] as? Bool {
        return enabled
      }
      if let value = features?["projectCatalog"] as? Bool {
        return value
      }
      if let projectCatalog = features?["project_catalog"] as? [String: Any],
         let enabled = projectCatalog["enabled"] as? Bool {
        return enabled
      }
      if let value = features?["project_catalog"] as? Bool {
        return value
      }
      return false
    }()
    remoteProjectCatalog = []
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

    reconnectState.reset()
    allowAutoReconnect = true
    setAutoReconnectPausedByUser(false)
    // Do NOT set latestRemoteDbVersion to the server's version here.
    // The mobile should only claim a dbVersion it actually received via
    // changeset_batch. Setting it prematurely causes the desktop to skip
    // the full initial sync on reconnect (it thinks we already have the data).
    outboundLocalDbVersion = database.currentDbVersion()
    hostName = remoteHostName ?? activeHostProfile?.hostName
    connectionState = .connected
    currentAddress = connectedHost
    lastError = nil
    lastSyncAt = Date()
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
    startRelayLoop()
    startInitialHydrationTask(for: connectionGeneration)
    restoreChatEventSubscriptions()
  }

  private func failPendingRequests(with error: Error) {
    let friendlyError = SyncUserFacingError.error(from: error)
    let completions = pending
    pending.removeAll()
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
            try self.handleIncoming(text)
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
                userInfo: [NSLocalizedDescriptionKey: "The host stopped responding. Reconnecting now."]
              )
            } else {
              failure = error
            }
            self.handleTransportFailure(
              failure,
              phase: .disconnected,
              connectionState: .disconnected,
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
    allowAutoReconnect = false
    autoReconnectAwaitingLiveDiscovery = false
    let friendlyError = SyncUserFacingError.error(from: error)
    teardownSocket(reason: friendlyError.localizedDescription)
    lastError = friendlyError.localizedDescription
    connectionState = .error
    setDomainStatus(SyncDomain.allCases, phase: .failed, error: friendlyError.localizedDescription)
    failPendingRequests(with: friendlyError)
    cancelReconnectLoop()
  }

  private func handleIncoming(_ text: String) throws {
    guard let data = text.data(using: .utf8) else { return }
    guard let envelope = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
    let type = envelope["type"] as? String ?? ""
    let requestId = envelope["requestId"] as? String
    let payload = try decodeEnvelopePayload(envelope)

    switch type {
    case "hello_ok":
      reconnectState.reset()
      resolve(requestId: requestId, result: .success(payload))
    case "project_catalog":
      let catalog = try decode(payload, as: MobileProjectCatalogPayload.self)
      applyRemoteProjectCatalog(catalog)
      resolve(requestId: requestId, result: .success(payload))
    case "project_switch_result":
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
      let batch = try decode(payload, as: SyncChangesetBatchPayload.self)
      let result = try database.applyChanges(batch.changes)
      latestRemoteDbVersion = max(latestRemoteDbVersion, batch.toDbVersion, result.dbVersion)
      lastSyncAt = Date()
      updateProfile { profile in
        profile.lastRemoteDbVersion = latestRemoteDbVersion
      }
      resolve(requestId: requestId, result: .success(payload))
    case "brain_status":
      if let dict = payload as? [String: Any], let brain = dict["brain"] as? [String: Any] {
        hostName = brain["deviceName"] as? String
        updateProfile { profile in
          profile.hostName = brain["deviceName"] as? String
          profile.lastHostDeviceId = brain["deviceId"] as? String
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
    case "command_result", "file_response", "terminal_snapshot":
      resolve(requestId: requestId, result: .success(payload))
    case "chat_subscribe":
      if supportsChatStreaming,
         let dict = payload as? [String: Any],
         let snapshot = try? decode(dict, as: SyncChatSubscribeSnapshotPayload.self) {
        mergeChatEventHistory(sessionId: snapshot.sessionId, events: snapshot.events)
      }
    case "chat_event":
      if supportsChatStreaming,
         let dict = payload as? [String: Any],
         let envelope = try? decode(dict, as: AgentChatEventEnvelope.self) {
        recordChatEventEnvelope(envelope)
      }
    case "terminal_data":
      if let dict = payload as? [String: Any], let sessionId = dict["sessionId"] as? String, let chunk = dict["data"] as? String {
        terminalBuffers[sessionId] = trimmedTerminalBuffer((terminalBuffers[sessionId] ?? "") + chunk)
        markTerminalBufferChanged()
      }
    case "terminal_exit":
      if let dict = payload as? [String: Any], let sessionId = dict["sessionId"] as? String {
        let exitCode = dict["exitCode"] as? Int
        terminalBuffers[sessionId] = trimmedTerminalBuffer((terminalBuffers[sessionId] ?? "") + "\n\n[process exited\(exitCode.map { " with \($0)" } ?? "")]")
        markTerminalBufferChanged(immediate: true)
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

  private func startInitialHydrationTask(for connectionGeneration: UInt64) {
    hydrationTask?.cancel()
    hydrationTask = Task { @MainActor [weak self] in
      guard let self else { return }
      await self.performInitialHydration(for: connectionGeneration)
      guard self.isCurrentConnectionGeneration(connectionGeneration) else { return }
      await self.flushPendingOperations()
    }
  }

  private func isCurrentConnectionGeneration(_ generation: UInt64) -> Bool {
    !Task.isCancelled && connectionGeneration == generation
  }

  private func sendLocalChanges() {
    guard canSendLiveRequests() else { return }
    let currentDbVersion = database.currentDbVersion()
    guard currentDbVersion > outboundLocalDbVersion else { return }
    let localSiteId = database.localSiteId()
    let changes = database.exportChangesSince(version: outboundLocalDbVersion).filter { $0.siteId == localSiteId }
    let previousDbVersion = outboundLocalDbVersion
    outboundLocalDbVersion = currentDbVersion
    guard !changes.isEmpty else { return }

    let payload = SyncChangesetBatchPayload(
      reason: "relay",
      fromDbVersion: previousDbVersion,
      toDbVersion: currentDbVersion,
      changes: changes
    )
    latestRemoteDbVersion = max(latestRemoteDbVersion, currentDbVersion)
    guard let payloadObject = try? jsonObject(from: payload) else { return }
    sendEnvelope(type: "changeset_batch", requestId: nil, payload: payloadObject)
  }

  private func resolve(requestId: String?, result: Result<Any, Error>) {
    guard let requestId, let request = pending.removeValue(forKey: requestId) else { return }
    request.timeoutTask.cancel()
    switch result {
    case .success(let payload):
      request.completion(.success(payload))
    case .failure(let error):
      request.completion(.failure(SyncUserFacingError.error(from: error)))
    }
  }

  private func awaitResponse(
    requestId: String,
    disconnectOnTimeout: Bool = true,
    timeoutMessage: String = SyncRequestTimeout.message,
    send: () -> Void
  ) async throws -> Any {
    try await withCheckedThrowingContinuation { continuation in
      let timeoutTask = Task { @MainActor [weak self] in
        try? await Task.sleep(nanoseconds: SyncRequestTimeout.defaultTimeoutNanoseconds)
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
        timeoutTask: timeoutTask
      )
      send()
    }
  }

  private func sendEnvelope(type: String, requestId: String?, payload: Any) {
    guard let socket else { return }
    let sendSocket = socket
    guard let payloadData = try? adeJSONData(withJSONObject: payload) else { return }

    let envelope: [String: Any]
    if payloadData.count >= compressionThresholdBytes {
      envelope = [
        "version": 1,
        "type": type,
        "requestId": requestId as Any,
        "compression": "gzip",
        "payloadEncoding": "base64",
        "payload": gzip(payloadData).base64EncodedString(),
        "uncompressedBytes": payloadData.count,
      ]
    } else {
      envelope = [
        "version": 1,
        "type": type,
        "requestId": requestId as Any,
        "compression": "none",
        "payloadEncoding": "json",
        "payload": payload,
      ]
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
              userInfo: [NSLocalizedDescriptionKey: "Timed out waiting for the host connection to open."]
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
    relayTask?.cancel()
    relayTask = nil
    hydrationTask?.cancel()
    hydrationTask = nil
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
    connectionGeneration &+= 1
  }

  private func handleTransportFailure(
    _ error: Error,
    phase: SyncDomainPhase = .failed,
    connectionState: RemoteConnectionState = .error,
    reconnectDelayNanoseconds: UInt64? = nil
  ) {
    let friendlyError = SyncUserFacingError.error(from: error)
    teardownSocket(reason: friendlyError.localizedDescription)
    lastError = friendlyError.localizedDescription
    self.connectionState = connectionState
    if phase == .failed {
      setDomainStatus(SyncDomain.allCases, phase: .failed, error: friendlyError.localizedDescription)
    } else {
      setDomainStatus(SyncDomain.allCases, phase: .disconnected)
    }
    failPendingRequests(with: friendlyError)
    scheduleReconnectIfNeeded(after: reconnectDelayNanoseconds ?? reconnectDelay())
  }

  private func handlePendingRequestTimeout(
    requestId: String,
    disconnectOnTimeout: Bool = true,
    timeoutError: NSError = SyncRequestTimeout.error()
  ) {
    guard pending[requestId] != nil else { return }
    if disconnectOnTimeout {
      handleTransportFailure(timeoutError)
    } else {
      resolve(requestId: requestId, result: .failure(timeoutError))
    }
  }

  private func decodeEnvelopePayload(_ envelope: [String: Any]) throws -> Any {
    let compression = envelope["compression"] as? String ?? "none"
    if compression == "gzip", let base64 = envelope["payload"] as? String, let compressed = Data(base64Encoded: base64) {
      let data = try gunzip(compressed)
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

  private func sendDecodableCommand<T: Decodable>(action: String, args: [String: Any] = [:], as type: T.Type) async throws -> T {
    let response = try await sendCommand(action: action, args: args)
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

  private func enqueueOperation(kind: String, action: String, args: [String: Any]) throws {
    guard JSONSerialization.isValidJSONObject(args) else {
      throw NSError(domain: "ADE", code: 11, userInfo: [NSLocalizedDescriptionKey: "Invalid queued operation payload."])
    }
    let payload = try adeJSONData(withJSONObject: args)
    var queued = loadPendingOperations()
    queued.append(PendingOperation(
      id: makeRequestId(),
      kind: kind,
      action: action,
      payload: payload,
      queuedAt: ISO8601DateFormatter().string(from: Date())
    ))
    savePendingOperations(queued)
  }

  private func decodeQueuedArgs(_ operation: PendingOperation) throws -> [String: Any] {
    let raw = try JSONSerialization.jsonObject(with: operation.payload, options: [])
    guard let dict = raw as? [String: Any] else {
      throw NSError(domain: "ADE", code: 12, userInfo: [NSLocalizedDescriptionKey: "Queued operation payload is invalid."])
    }
    return dict
  }

  private func flushPendingOperations() async {
    guard canSendLiveRequests() else { return }
    var queued = loadPendingOperations()
    guard !queued.isEmpty else {
      pendingOperationCount = 0
      return
    }

    while !queued.isEmpty {
      let operation = queued[0]
      do {
        let args = try decodeQueuedArgs(operation)
        switch operation.kind {
        case "command":
          guard commandPolicy(for: operation.action) != nil else {
            throw NSError(domain: "ADE", code: 16, userInfo: [NSLocalizedDescriptionKey: "Queued action \(operation.action) is no longer available on this host."])
          }
          _ = try await performCommandRequest(action: operation.action, args: args)
        case "file":
          guard queueableFileActions.contains(operation.action) else {
            throw NSError(domain: "ADE", code: 17, userInfo: [NSLocalizedDescriptionKey: "Queued file action \(operation.action) is no longer supported."])
          }
          _ = try await performFileRequest(action: operation.action, args: args)
        default:
          throw NSError(domain: "ADE", code: 13, userInfo: [NSLocalizedDescriptionKey: "Unknown queued operation type."])
        }
        queued.removeFirst()
        savePendingOperations(queued)
      } catch {
        lastError = SyncUserFacingError.message(for: error)
        if canSendLiveRequests() {
          queued.removeFirst()
          savePendingOperations(queued)
          continue
        }
        savePendingOperations(queued)
        connectionState = .error
        break
      }
    }
  }

  private func performCommandRequest(
    action: String,
    args: [String: Any],
    disconnectOnTimeout: Bool = true,
    timeoutMessage: String = SyncRequestTimeout.message
  ) async throws -> Any {
    guard canSendLiveRequests() else {
      throw NSError(domain: "ADE", code: 14, userInfo: [NSLocalizedDescriptionKey: "The host is offline."])
    }
    let requestId = makeRequestId()
    let raw = try await awaitResponse(
      requestId: requestId,
      disconnectOnTimeout: disconnectOnTimeout,
      timeoutMessage: timeoutMessage
    ) {
      self.sendEnvelope(type: "command", requestId: requestId, payload: [
        "commandId": requestId,
        "action": action,
        "args": args,
      ])
    }
    return try unwrapSyncCommandResponse(raw)
  }

  private func sendCommand(action: String, args: [String: Any]) async throws -> Any {
    if canSendLiveRequests() {
      return try await performCommandRequest(action: action, args: args)
    }
    guard let policy = commandPolicy(for: action) else {
      throw NSError(domain: "ADE", code: 15, userInfo: [NSLocalizedDescriptionKey: "This action is not available for the current host. Reconnect to refresh lane capabilities."])
    }
    guard policy.queueable == true else {
      throw NSError(domain: "ADE", code: 15, userInfo: [NSLocalizedDescriptionKey: "This action requires a live connection to the host."])
    }
    try enqueueOperation(kind: "command", action: action, args: args)
    return ["queued": true]
  }

  private func chatSubscriptionPayload(sessionId: String) -> [String: Any] {
    [
      "sessionId": sessionId,
      "maxBytes": syncChatSubscriptionMaxBytes,
    ]
  }

  private func restoreChatEventSubscriptions() {
    guard canSendLiveRequests(), supportsChatStreaming else { return }
    for sessionId in subscribedChatSessionIds.sorted() {
      sendEnvelope(type: "chat_subscribe", requestId: nil, payload: chatSubscriptionPayload(sessionId: sessionId))
    }
  }

  func recordChatEventEnvelope(_ envelope: AgentChatEventEnvelope) {
    var events = chatEventEnvelopesBySession[envelope.sessionId] ?? []
    guard !events.contains(where: { $0.id == envelope.id }) else { return }
    // Fast path: arrival-order appends stay sorted when timestamps are
    // monotonically non-decreasing — common for live streaming. Out-of-order
    // deliveries (e.g., a delayed tool_result arriving after a later text
    // fragment, or a merge with a historical snapshot) fall through to the
    // full dedup/sort in deduplicatedChatEventHistory so bubble order matches
    // the replace/merge paths.
    let canAppendInOrder: Bool = {
      guard let last = events.last else { return true }
      let lastDate = Self.parseIso8601(last.timestamp)
      let envelopeDate = Self.parseIso8601(envelope.timestamp)
      if let lhs = envelopeDate, let rhs = lastDate { return lhs >= rhs }
      return envelope.timestamp >= last.timestamp
    }()
    if canAppendInOrder {
      events.append(envelope)
      events = trimChatEventHistory(events)
    } else {
      events = deduplicatedChatEventHistory(events + [envelope])
    }
    chatEventEnvelopesBySession[envelope.sessionId] = events
    chatEventRevisionsBySession[envelope.sessionId, default: 0] += 1
    lastSyncAt = Date()
    markChatEventsChanged()
  }

  func replaceChatEventHistory(sessionId: String, events: [AgentChatEventEnvelope]) {
    chatEventEnvelopesBySession[sessionId] = deduplicatedChatEventHistory(events)
    chatEventRevisionsBySession[sessionId, default: 0] += 1
    lastSyncAt = Date()
    markChatEventsChanged(immediate: true)
  }

  func mergeChatEventHistory(sessionId: String, events: [AgentChatEventEnvelope]) {
    let current = chatEventEnvelopesBySession[sessionId] ?? []
    chatEventEnvelopesBySession[sessionId] = deduplicatedChatEventHistory(current + events)
    chatEventRevisionsBySession[sessionId, default: 0] += 1
    lastSyncAt = Date()
    markChatEventsChanged(immediate: true)
  }

  private func deduplicatedChatEventHistory(_ events: [AgentChatEventEnvelope]) -> [AgentChatEventEnvelope] {
    var seen = Set<String>()
    let unique = events.filter { event in
      guard !seen.contains(event.id) else { return false }
      seen.insert(event.id)
      return true
    }
    .sorted { lhs, rhs in
      // Parse timestamps to Date before comparing — a lexicographic compare
      // misorders mixed ISO-8601 variants (e.g., "…56.500Z" sorts before
      // "…56Z" because "." < "Z" in ASCII, even though chronologically it's
      // half a second later).
      let lhsDate = Self.parseIso8601(lhs.timestamp)
      let rhsDate = Self.parseIso8601(rhs.timestamp)
      if lhsDate == rhsDate {
        if lhs.timestamp == rhs.timestamp {
          return (lhs.sequence ?? 0) < (rhs.sequence ?? 0)
        }
        return lhs.timestamp < rhs.timestamp
      }
      switch (lhsDate, rhsDate) {
      case (let l?, let r?): return l < r
      case (nil, _?): return true
      case (_?, nil): return false
      case (nil, nil): return lhs.timestamp < rhs.timestamp
      }
    }
    return trimChatEventHistory(unique)
  }

  private func trimChatEventHistory(_ events: [AgentChatEventEnvelope]) -> [AgentChatEventEnvelope] {
    guard events.count > chatEventHistoryMaxEvents else { return events }
    return Array(events.suffix(chatEventHistoryMaxEvents))
  }

  private func trimmedTerminalBuffer(_ buffer: String) -> String {
    guard buffer.count > syncTerminalBufferMaxCharacters else { return buffer }
    return String(buffer.suffix(syncTerminalBufferMaxCharacters))
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

  private func markChatEventsChanged(immediate: Bool = false) {
    if immediate {
      chatEventRevisionTask?.cancel()
      chatEventRevisionTask = nil
      chatEventNotificationRevision += 1
      return
    }

    guard chatEventRevisionTask == nil else { return }
    chatEventRevisionTask = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: 120_000_000)
      guard let self, !Task.isCancelled else { return }
      self.chatEventNotificationRevision += 1
      self.chatEventRevisionTask = nil
    }
  }

  private func resetChatEventState(clearHistory: Bool) {
    subscribedChatSessionIds.removeAll()
    if clearHistory {
      chatEventEnvelopesBySession.removeAll()
      chatEventRevisionsBySession.removeAll()
    }
    markChatEventsChanged(immediate: true)
    localStateRevision += 1
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
      try await InitialHydrationGate.waitForProjectRow(
        currentProjectId: {
          guard let activeProjectId = self.activeProjectId else {
            let cachedProjects = self.database.listMobileProjects()
            return cachedProjects.count == 1 ? cachedProjects[0].id : nil
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
      let cachedProjects = database.listMobileProjects()
      if cachedProjects.count == 1, let onlyProject = cachedProjects.first {
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
      throw NSError(domain: "ADE", code: 16, userInfo: [NSLocalizedDescriptionKey: "The host is offline."])
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
      throw NSError(domain: "ADE", code: 17, userInfo: [NSLocalizedDescriptionKey: "This file action requires a live connection to the host."])
    }
    try enqueueOperation(kind: "file", action: action, args: args)
    return ["queued": true]
  }
}

// MARK: - Push notifications, Live Activities, and remote commands (WS6)

/// Kinds of remote commands the iOS client sends to the desktop host.
///
/// Each case maps to a verb on the desktop `syncRemoteCommandService` and the
/// notification-bus router. Keep this enum in sync with the action switch
/// inside `SyncService.sendRemoteCommand(_:payload:)`.
enum RemoteCommandKind: String, Sendable {
  case approveSession
  case denySession
  case pauseSession
  case replyToSession
  case restartSession
  case retryPrChecks
  case openPr
  case setMutePush
}

extension SyncService: LiveActivityHost {
  /// `LiveActivityHost` conformance — called by `LiveActivityCoordinator` when
  /// the OS hands us a new push-to-start or per-activity update token.
  func sendPushToken(_ token: String, kind: PushTokenKind, sessionId: String?) async {
    await registerPushToken(token, kind: kind, sessionId: sessionId)
  }
}

extension SyncService {
  /// Send the `register_push_token` sync message to the currently connected
  /// host. No-ops when offline — APNs tokens are stable for the app install,
  /// so we simply re-upload on the next successful reconnect.
  func registerPushToken(_ hex: String, kind: PushTokenKind, sessionId: String?) async {
    let trimmed = hex.trimmingCharacters(in: .whitespaces).lowercased()
    guard !trimmed.isEmpty else { return }

    let wireKind: String
    switch kind {
    case .alert: wireKind = "alert"
    case .activityStart: wireKind = "activity-start"
    case .activityUpdate: wireKind = "activity-update"
    }

    let bundleId = Bundle.main.bundleIdentifier ?? "com.ade.ios"
    #if DEBUG
    let env = "sandbox"
    #else
    let env = "production"
    #endif

    var payload: [String: Any] = [
      "token": trimmed,
      "kind": wireKind,
      "env": env,
      "bundleId": bundleId,
    ]
    if let sessionId, !sessionId.isEmpty {
      payload["activityId"] = sessionId
    }

    sendEnvelope(type: "register_push_token", requestId: nil, payload: payload)
  }

  /// Upload the current notification preferences as a `notification_prefs`
  /// message. Serializes the flat iOS struct into the nested shape the desktop
  /// `NotificationPreferences` TypeScript type expects.
  func uploadNotificationPrefs(_ prefs: NotificationPreferences) {
    let nested = Self.encodeNotificationPrefsForDesktop(prefs)
    sendEnvelope(type: "notification_prefs", requestId: nil, payload: ["prefs": nested])
  }

  /// Ask the host to deliver a test push to this device. The desktop decides
  /// which token kind (alert vs activity) to target based on what it last saw
  /// from us.
  func sendTestPush() {
    sendEnvelope(type: "send_test_push", requestId: nil, payload: ["kind": "alert"])
  }

  /// Dispatch a remote command over the existing sync WebSocket. Used by:
  ///   • Notification action handlers in `AppDelegate`
  ///   • Live Activity `LiveActivityIntent` perform handlers (WS7)
  ///   • Control Widget intents (WS7)
  ///
  /// The caller supplies a loosely-typed payload so action-specific fields
  /// (sessionId, prNumber, text, ...) can be forwarded without defining one
  /// envelope per variant. Never logs the payload in plaintext because `text`
  /// for `.replyToSession` is user-authored content.
  func sendRemoteCommand(_ kind: RemoteCommandKind, payload: [String: Any]) async {
    let action: String
    switch kind {
    case .approveSession: action = "chat.approve"
    case .denySession: action = "chat.approve"
    case .pauseSession: action = "chat.interrupt"
    case .replyToSession: action = "chat.respondToInput"
    case .restartSession: action = "chat.restart"
    case .retryPrChecks: action = "prs.rerunChecks"
    case .openPr: action = "prs.getDetail"
    case .setMutePush: action = "notification_prefs"
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
    case .pauseSession:
      if let sessionId = payload["sessionId"] as? String { args["sessionId"] = sessionId }
    case .replyToSession:
      // Desktop `chat.respondToInput` requires both sessionId AND itemId; the
      // itemId is the pending input marker the agent is waiting on.
      if let sessionId = payload["sessionId"] as? String { args["sessionId"] = sessionId }
      if let itemId = payload["itemId"] as? String { args["itemId"] = itemId }
      if let text = payload["text"] as? String { args["responseText"] = text }
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
    case .openPr:
      if let prNumber = payload["prNumber"] {
        args["prNumber"] = prNumber
      }
    case .setMutePush:
      // Route through the preferences updater — we overload the same envelope
      // rather than add yet another message type. The desktop honours the
      // `muteUntil` field it finds on the preferences payload.
      if let until = payload["muteUntil"] as? String {
        args["muteUntil"] = until
      } else {
        args["muteUntil"] = NSNull()
      }
    }

    // For now we send via the opaque command envelope — the desktop's
    // `syncRemoteCommandService` dispatches on `action`. Failures are
    // swallowed: notification actions are fire-and-forget and do not report
    // errors back to the user through this surface.
    do {
      _ = try await performCommandRequestSafe(action: action, args: args)
    } catch {
      // Intentionally silent — the host will retry once the user re-opens
      // the affected surface.
    }
  }

  private func performCommandRequestSafe(action: String, args: [String: Any]) async throws -> Any {
    if canSendLiveRequests() {
      return try await performCommandRequest(action: action, args: args)
    }
    guard let policy = commandPolicy(for: action), policy.queueable == true else {
      throw NSError(domain: "ADE", code: 15, userInfo: [NSLocalizedDescriptionKey: "Offline — command dropped."])
    }
    try enqueueOperation(kind: "command", action: action, args: args)
    return ["queued": true]
  }

  // MARK: - Workspace snapshot debounce

  /// Recompute `activeSessions` from the local `TerminalSessionSummary` roster
  /// and schedule a debounced snapshot write so widgets + live activities pick
  /// up the delta.
  func refreshActiveSessionsAndSnapshot() {
    let sessions = database.fetchSessions()
    let now = Date()
    // Staleness guard: dev iteration leaves many zombie sessions in the DB
    // with status="running" that were never cleanly terminated. Without a
    // recency filter the Live Activity / widget fills up with multi-hour-old
    // garbage. 2 hours covers long-running legitimate missions while
    // excluding overnight zombies. Awaiting-input always passes because the
    // user explicitly needs to see it even if it's old.
    let staleCutoffSeconds: TimeInterval = 2 * 60 * 60
    let agents: [AgentSnapshot] = sessions.compactMap { session in
      let isChat = (session.toolType?.contains("chat") == true)
      guard isChat else { return nil }
      let status = session.status.lowercased()
      guard status != "completed" && status != "failed" else { return nil }

      let awaiting = status == "awaiting_input"
      let started = Self.parseIso8601(session.startedAt) ?? now
      let lastActivity = Self.parseIso8601(session.endedAt ?? "") ?? now
      let elapsed = Int(max(0, lastActivity.timeIntervalSince(started)))

      if !awaiting && now.timeIntervalSince(started) > staleCutoffSeconds {
        return nil
      }

      return AgentSnapshot(
        sessionId: session.id,
        provider: session.toolType ?? "claude",
        title: session.title.isEmpty ? session.goal : session.title,
        status: status,
        awaitingInput: awaiting,
        lastActivityAt: lastActivity,
        elapsedSeconds: elapsed,
        preview: session.lastOutputPreview,
        progress: nil,
        phase: nil,
        toolCalls: 0
      )
    }

    activeSessions = agents

    if #available(iOS 16.2, *),
       let coord = liveActivityCoordinator as? LiveActivityCoordinator {
      let currentPrs: [PrSnapshot] = database
        .fetchPullRequestListItems()
        .prefix(12)
        .map { item in
          PrSnapshot(
            id: item.id,
            number: item.githubPrNumber,
            title: item.title,
            checks: item.checksStatus,
            review: item.reviewStatus,
            state: item.state,
            mergeReady: (item.reviewStatus == "approved")
              && (item.checksStatus == "passing")
              && item.state == "open",
            branch: item.headBranch.isEmpty ? nil : item.headBranch
          )
        }
      coord.reconcile(with: agents, prs: currentPrs)
    }

    scheduleWorkspaceSnapshotWrite()
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
        branch: item.headBranch.isEmpty ? nil : item.headBranch
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
      connection: connection
    )

    if ADESharedContainer.writeWorkspaceSnapshot(snapshot) {
      WidgetReloadBridge.reloadAllTimelines()
    }
  }

  // MARK: - NotificationPreferences shape translation

  /// Translate the flat iOS `NotificationPreferences` into the nested shape
  /// the desktop `SyncNotificationPrefsPayload` expects. Keeping the mapping
  /// local (rather than rewriting the iOS struct) avoids touching the
  /// persistence format that `NotificationsCenterView` already reads/writes.
  static func encodeNotificationPrefsForDesktop(
    _ prefs: NotificationPreferences
  ) -> [String: Any] {
    let anyEnabled = prefs.enabledCategoryCount > 0
    var dict: [String: Any] = [
      "enabled": anyEnabled,
      "chat": [
        "awaitingInput": prefs.chatAwaitingInput,
        "chatFailed": prefs.chatFailed,
        "turnCompleted": prefs.chatTurnCompleted,
      ],
      "cto": [
        "subagentStarted": prefs.ctoSubagentStarted,
        "subagentFinished": prefs.ctoSubagentFinished,
        "missionPhaseChanged": prefs.ctoMissionPhase,
      ],
      "prs": [
        "ciFailing": prefs.prCiFailing,
        "reviewRequested": prefs.prReviewRequested,
        "changesRequested": prefs.prChangesRequested,
        "mergeReady": prefs.prMergeReady,
      ],
      "system": [
        "providerOutage": prefs.systemProviderOutage,
        "authRateLimit": prefs.systemAuthRateLimit,
        "hookFailure": prefs.systemHookFailure,
      ],
    ]

    if let start = prefs.quietHoursStart, let end = prefs.quietHoursEnd {
      dict["quietHours"] = [
        "enabled": true,
        "start": Self.formatTimeOfDay(start),
        "end": Self.formatTimeOfDay(end),
        "timezone": TimeZone.current.identifier,
      ]
    }

    if !prefs.perSessionOverrides.isEmpty {
      dict["perSessionOverrides"] = prefs.perSessionOverrides.mapValues { override in
        [
          "muted": override.muted,
          "awaitingInputOnly": override.awaitingInputOnly,
        ]
      }
    }

    return dict
  }

  private static func formatTimeOfDay(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = .current
    formatter.dateFormat = "HH:mm"
    return formatter.string(from: date)
  }

  private static func parseIso8601(_ raw: String) -> Date? {
    guard !raw.isEmpty else { return nil }
    let iso = ISO8601DateFormatter()
    iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = iso.date(from: raw) { return date }
    iso.formatOptions = [.withInternetDateTime]
    return iso.date(from: raw)
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
        let canConnect = await probe(host: host, port: port)
        guard canConnect else { continue }
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
          lastResolvedAt: ISO8601DateFormatter().string(from: Date())
        )
        break
      }
    }
    onHostsChanged?(Array(nextHosts.values))
  }

  private func probe(host: String, port: Int) async -> Bool {
    guard let endpointPort = NWEndpoint.Port(rawValue: UInt16(port)) else { return false }
    return await withCheckedContinuation { continuation in
      let connection = NWConnection(
        host: NWEndpoint.Host(host),
        port: endpointPort,
        using: .tcp
      )
      var completed = false
      let complete: (Bool) -> Void = { result in
        guard !completed else { return }
        completed = true
        connection.cancel()
        continuation.resume(returning: result)
      }
      connection.stateUpdateHandler = { state in
        switch state {
        case .ready:
          complete(true)
        case .failed, .cancelled:
          complete(false)
        default:
          break
        }
      }
      connection.start(queue: connectionQueue)
      connectionQueue.asyncAfter(
        deadline: .now() + .nanoseconds(Int(SyncTailnetDiscoveryTiming.probeTimeoutNanoseconds))
      ) {
        complete(false)
      }
    }
  }
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
    let preferredHost = txtRecord["host"]?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let announcedAddresses = txtRecord["addresses"]?
      .split(separator: ",")
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) } ?? []
    let resolvedAddresses = service.addresses?
      .compactMap(parseHost(from:))
      .filter { !$0.isEmpty } ?? []
    let addresses = ([preferredHost]
      .compactMap { $0 }
      .filter { !$0.isEmpty })
      + resolvedAddresses
      + announcedAddresses
    let port = service.port > 0 ? service.port : Int(txtRecord["port"] ?? "") ?? 8787
    let hostName = txtRecord["deviceName"] ?? service.hostName ?? service.name
    let hostIdentity = txtRecord["deviceId"]
    let tailscaleDnsName = txtRecord["tailscaleDnsName"]?.trimmingCharacters(in: .whitespacesAndNewlines)
    let tailscaleIp = txtRecord["tailscaleIp"]?.trimmingCharacters(in: .whitespacesAndNewlines)
    let tailscaleAddress = [tailscaleDnsName, tailscaleIp]
      .compactMap { value -> String? in
        guard let value, !value.isEmpty, syncIsTailscaleRoute(value) else { return nil }
        return value
      }
      .first
    let sk = serviceKey(for: service)
    // Stable unique row id for SwiftUI: same `deviceId` can appear on multiple Bonjour rows.
    let id: String
    if let hostIdentity, !hostIdentity.isEmpty {
      id = "\(hostIdentity)::\(sk)"
    } else {
      id = sk
    }
    // Preserve source order (TXT-preferred first, resolved next), dedup, and
    // force any loopback candidate to the tail — a simulator sharing the host's
    // loopback can use it, but a physical device would waste a roundtrip if it
    // tried 127.0.0.1 first.
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
      serviceName: service.name,
      hostName: hostName,
      hostIdentity: hostIdentity,
      port: port,
      addresses: nonLoopback + loopback,
      tailscaleAddress: tailscaleAddress,
      lastResolvedAt: ISO8601DateFormatter().string(from: Date())
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

private func gunzip(_ data: Data) throws -> Data {
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
        output.append(baseAddress, count: produced)
      }
    }
  } while status == Z_OK

  guard status == Z_STREAM_END else {
    throw NSError(domain: "ADE", code: 10, userInfo: [NSLocalizedDescriptionKey: "Unable to decode compressed sync payload."])
  }
  return output
}
