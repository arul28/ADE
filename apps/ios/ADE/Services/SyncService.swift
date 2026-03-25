import Foundation
import SwiftUI
import UIKit
import zlib

enum RemoteConnectionState: String {
  case disconnected
  case connecting
  case connected
  case syncing
  case error
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
    let data = try JSONSerialization.data(withJSONObject: raw, options: [])
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

enum InitialHydrationGate {
  static let defaultTimeoutNanoseconds: UInt64 = 15_000_000_000
  static let defaultPollIntervalNanoseconds: UInt64 = 200_000_000

  @MainActor
  static func waitForProjectRow(
    timeoutNanoseconds: UInt64 = defaultTimeoutNanoseconds,
    pollIntervalNanoseconds: UInt64 = defaultPollIntervalNanoseconds,
    currentProjectId: () -> String?,
    sleep: @escaping (UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0) }
  ) async throws {
    guard currentProjectId() == nil else { return }

    var waited: UInt64 = 0
    while waited < timeoutNanoseconds {
      try await sleep(pollIntervalNanoseconds)
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

struct FilesNavigationRequest: Equatable, Identifiable {
  let id: String
  let workspaceId: String
  let relativePath: String?

  init(workspaceId: String, relativePath: String?) {
    self.id = UUID().uuidString
    self.workspaceId = workspaceId
    self.relativePath = relativePath
  }
}

@MainActor
final class SyncService: ObservableObject {
  @Published private(set) var connectionState: RemoteConnectionState = .disconnected
  @Published private(set) var hostName: String?
  @Published private(set) var activeHostProfile: HostConnectionProfile?
  @Published private(set) var discoveredHosts: [DiscoveredSyncHost] = []
  @Published private(set) var domainStatuses: [SyncDomain: SyncDomainStatus] = Dictionary(
    uniqueKeysWithValues: SyncDomain.allCases.map { ($0, .disconnected) }
  )
  @Published private(set) var lastSyncAt: Date?
  @Published private(set) var currentAddress: String?
  @Published private(set) var lastError: String?
  @Published private(set) var terminalBuffers: [String: String] = [:]
  @Published private(set) var pendingOperationCount = 0
  @Published private(set) var localStateRevision = 0
  @Published var settingsPresented = false
  @Published var requestedFilesNavigation: FilesNavigationRequest?

  private let legacyDraftKey = "ade.sync.connectionDraft"
  private let profileKey = "ade.sync.hostProfile"
  private let pendingOperationsKey = "ade.sync.pendingOperations"
  private let remoteCommandDescriptorsKey = "ade.sync.remoteCommandDescriptors"
  private let keychain = KeychainService()
  private let database: DatabaseService
  private var socket: URLSessionWebSocketTask?
  private var pending: [String: (Result<Any, Error>) -> Void] = [:]
  private let decoder = JSONDecoder()
  private let encoder = JSONEncoder()
  private let compressionThresholdBytes = 4 * 1024
  private var relayTask: Task<Void, Never>?
  private var reconnectTask: Task<Void, Never>?
  private var databaseObserver: NSObjectProtocol?
  private var latestRemoteDbVersion = 0
  private var outboundLocalDbVersion = 0
  private let discoveryBrowser = SyncBonjourBrowser()
  private var reconnectAttempts = 0
  private var allowAutoReconnect = true
  private(set) var deviceId: String
  private var remoteCommandDescriptors: [SyncRemoteCommandDescriptor] = []

  var hasCachedHostData: Bool {
    database.hasHydratedControllerData()
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
    self.database = database
    if let existing = UserDefaults.standard.string(forKey: "ade.sync.deviceId") {
      deviceId = existing
    } else {
      let fresh = UUID().uuidString.lowercased()
      UserDefaults.standard.set(fresh, forKey: "ade.sync.deviceId")
      deviceId = fresh
    }
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
        self?.applyDiscoveredHosts(hosts)
      }
    }
    discoveryBrowser.start()

    databaseObserver = NotificationCenter.default.addObserver(
      forName: .adeDatabaseDidChange,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      guard let self else { return }
      Task { @MainActor in
        self.localStateRevision += 1
      }
    }
  }

  deinit {
    relayTask?.cancel()
    reconnectTask?.cancel()
    discoveryBrowser.stop()
    if let databaseObserver {
      NotificationCenter.default.removeObserver(databaseObserver)
    }
  }

  func loadProfile() -> HostConnectionProfile? {
    if let data = UserDefaults.standard.data(forKey: profileKey),
       let profile = try? decoder.decode(HostConnectionProfile.self, from: data) {
      return profile
    }
    guard let data = UserDefaults.standard.data(forKey: legacyDraftKey),
          let draft = try? decoder.decode(ConnectionDraft.self, from: data) else {
      return nil
    }
    let migrated = HostConnectionProfile(legacy: draft)
    saveProfile(migrated)
    return migrated
  }

  func loadDraft() -> ConnectionDraft? {
    guard let profile = loadProfile() else { return nil }
    return ConnectionDraft(
      host: profile.lastSuccessfulAddress ?? profile.savedAddressCandidates.first ?? "127.0.0.1",
      port: profile.port,
      authKind: profile.authKind,
      pairedDeviceId: profile.pairedDeviceId,
      lastRemoteDbVersion: profile.lastRemoteDbVersion,
      lastBrainDeviceId: profile.lastHostDeviceId
    )
  }

  func reconnectIfPossible() async {
    do {
      try ensureDatabaseReady()
    } catch {
      lastError = error.localizedDescription
      connectionState = .error
      return
    }
    allowAutoReconnect = true
    guard let profile = loadProfile(), let token = keychain.loadToken() else { return }
    do {
      let connectedAddress = try await connectUsingProfile(profile, token: token)
      currentAddress = connectedAddress
    } catch {
      handleReconnectFailure(error)
    }
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
      lastError = error.localizedDescription
      connectionState = .error
      return
    }
    do {
      allowAutoReconnect = true
      let addressCandidates = deduplicatedAddresses([host] + candidateAddresses)
      let preferredAddress = addressCandidates.first ?? host
      try await openSocket(host: preferredAddress, port: port)
      let requestId = makeRequestId()
      let raw = try await awaitResponse(requestId: requestId) {
        self.sendEnvelope(type: "pairing_request", requestId: requestId, payload: [
          "code": code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased(),
          "peer": self.currentPeerMetadata(),
        ])
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
      let profile = HostConnectionProfile(
        hostIdentity: hostIdentity,
        hostName: hostName,
        port: port,
        authKind: "paired",
        pairedDeviceId: pairedDeviceId,
        lastRemoteDbVersion: 0,
        lastHostDeviceId: nil,
        lastSuccessfulAddress: preferredAddress,
        savedAddressCandidates: addressCandidates,
        discoveredLanAddresses: addressCandidates.filter { !$0.contains("100.") && !$0.contains(":") },
        tailscaleAddress: tailscaleAddress
      )
      saveProfile(profile)
      currentAddress = preferredAddress
      try await hello(host: preferredAddress, port: port, token: secret, authKind: "paired", pairedDeviceId: pairedDeviceId, expectedHostIdentity: hostIdentity)
    } catch {
      lastError = error.localizedDescription
      connectionState = .error
      setDomainStatus(SyncDomain.allCases, phase: .failed, error: error.localizedDescription)
    }
  }

  func pairAndConnect(using payload: SyncPairingQrPayload) async {
    let candidateAddresses = deduplicatedAddresses(payload.addressCandidates.map(\.host))
    await pairAndConnect(
      host: candidateAddresses.first ?? "127.0.0.1",
      port: payload.port,
      code: payload.pairingCode,
      hostIdentity: payload.hostIdentity.deviceId,
      hostName: payload.hostIdentity.name,
      candidateAddresses: candidateAddresses,
      tailscaleAddress: payload.addressCandidates.first(where: { $0.kind == "tailscale" })?.host
    )
  }

  func decodePairingQrPayload(from rawValue: String) throws -> SyncPairingQrPayload {
    let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)

    if let data = trimmed.data(using: .utf8), let payload = try? decoder.decode(SyncPairingQrPayload.self, from: data) {
      return payload
    }

    if let url = URL(string: trimmed), let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
       let payloadValue = components.queryItems?.first(where: { $0.name == "payload" })?.value {
      let json = payloadValue.removingPercentEncoding ?? payloadValue
      if let data = json.data(using: .utf8), let payload = try? decoder.decode(SyncPairingQrPayload.self, from: data) {
        return payload
      }
    }

    throw NSError(domain: "ADE", code: 22, userInfo: [NSLocalizedDescriptionKey: "That QR code is not a valid ADE pairing payload."])
  }

  private func friendlyPairingFailureMessage(_ raw: Any) -> String {
    let error = (raw as? [String: Any])?["error"] as? [String: Any]
    let code = error?["code"] as? String
    let message = error?["message"] as? String

    switch code {
    case "expired_code":
      return "That pairing code expired. Open Sync on the host again and use the fresh code shown there."
    case "invalid_code":
      return "That pairing code does not match the current host. Open Sync on the host again and enter the fresh code."
    case "pairing_unavailable":
      return "Phone pairing is not available on the host right now. Reopen Sync on the host and try again."
    default:
      return message ?? "Pairing failed."
    }
  }

  func disconnect(clearCredentials: Bool = false) {
    allowAutoReconnect = false
    reconnectTask?.cancel()
    relayTask?.cancel()
    relayTask = nil
    socket?.cancel(with: .normalClosure, reason: nil)
    socket = nil
    connectionState = .disconnected
    hostName = activeHostProfile?.hostName
    currentAddress = nil
    latestRemoteDbVersion = 0
    outboundLocalDbVersion = database.currentDbVersion()
    setDomainStatus(SyncDomain.allCases, phase: .disconnected)
    if clearCredentials {
      keychain.clearToken()
      saveProfile(nil)
      saveRemoteCommandDescriptors([])
      activeHostProfile = nil
      hostName = nil
    }
    failPendingRequests(with: NSError(domain: "ADE", code: 21, userInfo: [NSLocalizedDescriptionKey: "Connection closed."]))
  }

  func forgetHost() {
    disconnect(clearCredentials: true)
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
      if connectionState == .disconnected || connectionState == .error {
        setDomainStatus([.lanes, .files], phase: .disconnected)
      } else {
        setDomainStatus([.lanes, .files], phase: .failed, error: error.localizedDescription)
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
      if connectionState == .disconnected || connectionState == .error {
        setDomainStatus([.work], phase: .disconnected)
      } else {
        setDomainStatus([.work], phase: .failed, error: error.localizedDescription)
      }
      throw error
    }
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
      if connectionState == .disconnected || connectionState == .error {
        setDomainStatus([.prs], phase: .disconnected)
      } else {
        setDomainStatus([.prs], phase: .failed, error: error.localizedDescription)
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
      if connectionState == .disconnected || connectionState == .error {
        setDomainStatus([.lanes], phase: .disconnected)
      } else {
        setDomainStatus([.lanes], phase: .failed, error: error.localizedDescription)
      }
      throw error
    }
  }

  func fetchLaneDetail(laneId: String) async throws -> LaneDetailPayload? {
    database.fetchLaneDetail(laneId: laneId)
  }

  func listWorkspaces() async throws -> [FilesWorkspace] {
    database.listWorkspaces()
  }

  func fetchSessions() async throws -> [TerminalSessionSummary] {
    database.fetchSessions()
  }

  func fetchPullRequests() async throws -> [PrSummary] {
    database.fetchPullRequests()
  }

  func fetchPullRequestSnapshot(prId: String) async throws -> PullRequestSnapshot? {
    database.fetchPullRequestSnapshot(prId: prId)
  }

  func status(for domain: SyncDomain) -> SyncDomainStatus {
    domainStatuses[domain] ?? .disconnected
  }

  func readFile(workspaceId: String, path: String) async throws -> SyncFileBlob {
    try decode(
      try await performFileRequest(action: "readFile", args: [
        "workspaceId": workspaceId,
        "path": path,
      ]),
      as: SyncFileBlob.self
    )
  }

  func writeText(workspaceId: String, path: String, text: String) async throws {
    _ = try await sendFileRequest(action: "writeText", args: [
      "workspaceId": workspaceId,
      "path": path,
      "text": text,
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

  func listTree(workspaceId: String, parentPath: String = "") async throws -> [FileTreeNode] {
    try decode(
      try await performFileRequest(action: "listTree", args: [
        "workspaceId": workspaceId,
        "parentPath": parentPath,
        "depth": 1,
      ]),
      as: [FileTreeNode].self
    )
  }

  func subscribeTerminal(sessionId: String) async throws {
    let requestId = makeRequestId()
    let raw = try await awaitResponse(requestId: requestId) {
      self.sendEnvelope(type: "terminal_subscribe", requestId: requestId, payload: [
        "sessionId": sessionId,
        "maxBytes": 220000,
      ])
    }
    let snapshot = try decode(raw, as: TerminalSnapshot.self)
    terminalBuffers[sessionId] = snapshot.transcript
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

  func renameLane(_ laneId: String, name: String) async throws {
    _ = try await sendCommand(action: "lanes.rename", args: ["laneId": laneId, "name": name])
  }

  func reparentLane(_ laneId: String, newParentLaneId: String) async throws {
    _ = try await sendCommand(action: "lanes.reparent", args: ["laneId": laneId, "newParentLaneId": newParentLaneId])
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

  func startLaneRebase(laneId: String, scope: String = "lane_only", pushMode: String = "none") async throws {
    _ = try await sendCommand(action: "lanes.rebaseStart", args: [
      "laneId": laneId,
      "scope": scope,
      "pushMode": pushMode,
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

  func fetchFileDiff(laneId: String, path: String, mode: String, compareRef: String? = nil, compareTo: String? = nil) async throws -> FileDiff {
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
    return try await sendDecodableCommand(action: "git.getFile", args: args, as: FileDiff.self)
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

  func createChatSession(laneId: String, provider: String, model: String = "", reasoningEffort: String? = nil) async throws -> AgentChatSessionSummary {
    var args: [String: Any] = [
      "laneId": laneId,
      "provider": provider,
      "model": model,
    ]
    if let reasoningEffort, !reasoningEffort.isEmpty {
      args["reasoningEffort"] = reasoningEffort
    }
    return try await sendDecodableCommand(action: "chat.create", args: args, as: AgentChatSessionSummary.self)
  }

  func fetchChatSummary(sessionId: String) async throws -> AgentChatSessionSummary {
    try await sendDecodableCommand(action: "chat.getSummary", args: ["sessionId": sessionId], as: AgentChatSessionSummary.self)
  }

  func fetchChatTranscript(sessionId: String, limit: Int = 200, maxChars: Int = 32_000) async throws -> [AgentChatTranscriptEntry] {
    try await sendDecodableCommand(
      action: "chat.getTranscript",
      args: ["sessionId": sessionId, "limit": limit, "maxChars": maxChars],
      as: [AgentChatTranscriptEntry].self
    )
  }

  func sendChatMessage(sessionId: String, text: String) async throws {
    _ = try await sendCommand(action: "chat.send", args: ["sessionId": sessionId, "text": text])
  }

  func createPullRequest(laneId: String, title: String, body: String, reviewers: [String]) async throws {
    _ = try await sendCommand(action: "prs.createFromLane", args: [
      "laneId": laneId,
      "title": title,
      "body": body,
      "draft": false,
      "reviewers": reviewers,
    ])
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

  private func saveProfile(_ profile: HostConnectionProfile?) {
    if let profile, let data = try? encoder.encode(profile) {
      UserDefaults.standard.set(data, forKey: profileKey)
      activeHostProfile = profile
      hostName = profile.hostName
    } else {
      UserDefaults.standard.removeObject(forKey: profileKey)
      UserDefaults.standard.removeObject(forKey: legacyDraftKey)
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

  private func deduplicatedAddresses(_ addresses: [String]) -> [String] {
    var seen = Set<String>()
    return addresses
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
      .filter { seen.insert($0).inserted }
  }

  private func prioritizedAddresses(for profile: HostConnectionProfile) -> [String] {
    let matchingDiscovery = discoveredHosts.filter { host in
      guard let hostIdentity = profile.hostIdentity else { return true }
      return host.hostIdentity == nil || host.hostIdentity == hostIdentity
    }

    let liveLan = matchingDiscovery.flatMap(\.addresses)
    let liveTailscale = matchingDiscovery.compactMap(\.tailscaleAddress)
    return deduplicatedAddresses(
      liveLan +
      (profile.lastSuccessfulAddress.map { [$0] } ?? []) +
      profile.savedAddressCandidates +
      profile.discoveredLanAddresses +
      liveTailscale +
      (profile.tailscaleAddress.map { [$0] } ?? [])
    )
  }

  private func connectUsingProfile(_ profile: HostConnectionProfile, token: String) async throws -> String {
    var lastFailure: Error?
    let addresses = prioritizedAddresses(for: profile)
    guard !addresses.isEmpty else {
      throw NSError(domain: "ADE", code: 18, userInfo: [NSLocalizedDescriptionKey: "No saved address is available for this host."])
    }

    for address in addresses {
      do {
        try await openSocket(host: address, port: profile.port)
        try await hello(
          host: address,
          port: profile.port,
          token: token,
          authKind: profile.authKind,
          pairedDeviceId: profile.pairedDeviceId,
          expectedHostIdentity: profile.hostIdentity
        )
        return address
      } catch {
        lastFailure = error
        if shouldInvalidateSavedPairing(for: error) {
          forgetHost()
          throw error
        }
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
      }
    }

    throw lastFailure ?? NSError(domain: "ADE", code: 19, userInfo: [NSLocalizedDescriptionKey: "Unable to reach the saved ADE host."])
  }

  private func handleReconnectFailure(_ error: Error) {
    if shouldInvalidateSavedPairing(for: error) {
      forgetHost()
      return
    }
    lastError = error.localizedDescription
    connectionState = .error
    setDomainStatus(SyncDomain.allCases, phase: .failed, error: error.localizedDescription)
    scheduleReconnectIfNeeded(after: reconnectDelay())
  }

  private func reconnectDelay() -> UInt64 {
    let exponent = min(reconnectAttempts, 4)
    let seconds = UInt64(1 << exponent)
    reconnectAttempts += 1
    return seconds * 1_000_000_000
  }

  private func scheduleReconnectIfNeeded(after delayNanoseconds: UInt64) {
    guard allowAutoReconnect, loadProfile() != nil, keychain.loadToken() != nil else { return }
    reconnectTask?.cancel()
    reconnectTask = Task { @MainActor in
      try? await Task.sleep(nanoseconds: delayNanoseconds)
      guard !Task.isCancelled else { return }
      await reconnectIfPossible()
    }
  }

  private func cancelReconnectLoop() {
    reconnectAttempts = 0
    reconnectTask?.cancel()
    reconnectTask = nil
  }

  private func shouldInvalidateSavedPairing(for error: Error) -> Bool {
    let nsError = error as NSError
    return nsError.userInfo["ADEErrorCode"] as? String == "auth_failed"
  }

  private func applyDiscoveredHosts(_ hosts: [DiscoveredSyncHost]) {
    discoveredHosts = hosts.sorted { $0.hostName.localizedCaseInsensitiveCompare($1.hostName) == .orderedAscending }
    guard let profile = activeHostProfile else { return }
    let matching = discoveredHosts.filter { discovered in
      guard let hostIdentity = profile.hostIdentity else { return true }
      return discovered.hostIdentity == hostIdentity
    }
    guard !matching.isEmpty else { return }
    updateProfile { profile in
      profile.discoveredLanAddresses = deduplicatedAddresses(matching.flatMap(\.addresses))
      profile.tailscaleAddress = matching.compactMap(\.tailscaleAddress).first ?? profile.tailscaleAddress
      if profile.hostName == nil {
        profile.hostName = matching.first?.hostName
      }
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

  private func openSocket(host: String, port: Int) async throws {
    relayTask?.cancel()
    socket?.cancel(with: .goingAway, reason: nil)
    socket = nil
    connectionState = .connecting
    hostName = activeHostProfile?.hostName
    currentAddress = host

    let urlString: String
    if host.contains(":") && !host.hasPrefix("[") {
      urlString = "ws://[\(host)]:\(port)"
    } else {
      urlString = "ws://\(host):\(port)"
    }

    guard let url = URL(string: urlString) else {
      throw NSError(domain: "ADE", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid host address."])
    }
    let task = URLSession.shared.webSocketTask(with: url)
    task.resume()
    socket = task
    receiveLoop(for: task)
  }

  private func hello(
    host: String,
    port: Int,
    token: String,
    authKind: String,
    pairedDeviceId: String?,
    expectedHostIdentity: String?
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
    guard let payload = raw as? [String: Any] else {
      throw NSError(domain: "ADE", code: 4, userInfo: [NSLocalizedDescriptionKey: "Invalid hello response."])
    }
    try applyHelloPayload(
      payload,
      connectedHost: host,
      port: port,
      authKind: authKind,
      pairedDeviceId: pairedDeviceId,
      expectedHostIdentity: expectedHostIdentity
    )
  }

  private func applyHelloPayload(
    _ payload: [String: Any],
    connectedHost: String,
    port: Int,
    authKind: String,
    pairedDeviceId: String?,
    expectedHostIdentity: String?
  ) throws {
    let remoteDbVersion = payload["serverDbVersion"] as? Int ?? 0
    let brain = payload["brain"] as? [String: Any]
    let remoteHostIdentity = brain?["deviceId"] as? String
    let remoteHostName = brain?["deviceName"] as? String
    let commandDescriptors: [SyncRemoteCommandDescriptor] = {
      guard
        let features = payload["features"] as? [String: Any],
        let commandRouting = features["commandRouting"],
        let actions = (commandRouting as? [String: Any])?["actions"]
      else {
        return []
      }
      return (try? decode(actions, as: [SyncRemoteCommandDescriptor].self)) ?? []
    }()

    if let expectedHostIdentity, let remoteHostIdentity, expectedHostIdentity != remoteHostIdentity {
      forgetHost()
      throw NSError(
        domain: "ADE",
        code: 20,
        userInfo: [NSLocalizedDescriptionKey: "The saved pairing belongs to a different ADE host. Pair again with the current host."]
      )
    }

    latestRemoteDbVersion = remoteDbVersion
    outboundLocalDbVersion = database.currentDbVersion()
    hostName = remoteHostName ?? activeHostProfile?.hostName
    connectionState = .connected
    currentAddress = connectedHost
    lastError = nil
    lastSyncAt = Date()
    saveRemoteCommandDescriptors(commandDescriptors)

    let matchingDiscovery = discoveredHosts.first { discovered in
      discovered.hostIdentity == remoteHostIdentity || discovered.addresses.contains(connectedHost)
    }
    let savedCandidates = deduplicatedAddresses(
      [connectedHost] +
      (activeHostProfile?.savedAddressCandidates ?? []) +
      (matchingDiscovery?.addresses ?? [])
    )
    let discoveredLan = deduplicatedAddresses(
      matchingDiscovery?.addresses ?? activeHostProfile?.discoveredLanAddresses ?? []
    )

    let profile = HostConnectionProfile(
      hostIdentity: remoteHostIdentity ?? activeHostProfile?.hostIdentity ?? expectedHostIdentity,
      hostName: remoteHostName ?? activeHostProfile?.hostName,
      port: port,
      authKind: authKind,
      pairedDeviceId: pairedDeviceId ?? activeHostProfile?.pairedDeviceId,
      lastRemoteDbVersion: remoteDbVersion,
      lastHostDeviceId: remoteHostIdentity ?? activeHostProfile?.lastHostDeviceId,
      lastSuccessfulAddress: connectedHost,
      savedAddressCandidates: savedCandidates,
      discoveredLanAddresses: discoveredLan,
      tailscaleAddress: matchingDiscovery?.tailscaleAddress ?? activeHostProfile?.tailscaleAddress
    )
    saveProfile(profile)
    startRelayLoop()

    Task { @MainActor in
      await self.performInitialHydration()
      await self.flushPendingOperations()
    }
  }

  private func failPendingRequests(with error: Error) {
    let completions = pending
    pending.removeAll()
    for completion in completions.values {
      completion(.failure(error))
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
          try self.handleIncoming(text)
        } catch {
          if self.socket === task {
            self.connectionState = .disconnected
            self.lastError = error.localizedDescription
            self.currentAddress = nil
            self.setDomainStatus(SyncDomain.allCases, phase: .disconnected)
            self.failPendingRequests(with: error)
            self.scheduleReconnectIfNeeded(after: self.reconnectDelay())
          }
          break
        }
      }
    }
  }

  private func handleIncoming(_ text: String) throws {
    guard let data = text.data(using: .utf8) else { return }
    guard let envelope = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
    let type = envelope["type"] as? String ?? ""
    let requestId = envelope["requestId"] as? String
    let payload = try decodeEnvelopePayload(envelope)

    switch type {
    case "hello_ok":
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
      connectionState = .syncing
      let batch = try decode(payload, as: SyncChangesetBatchPayload.self)
      let result = try database.applyChanges(batch.changes)
      latestRemoteDbVersion = max(latestRemoteDbVersion, batch.toDbVersion, result.dbVersion)
      lastSyncAt = Date()
      updateProfile { profile in
        profile.lastRemoteDbVersion = latestRemoteDbVersion
      }
      resolve(requestId: requestId, result: .success(payload))
      Task { @MainActor in
        try? await Task.sleep(nanoseconds: 150_000_000)
        if self.connectionState == .syncing {
          self.connectionState = .connected
        }
      }
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
    case "terminal_data":
      if let dict = payload as? [String: Any], let sessionId = dict["sessionId"] as? String, let chunk = dict["data"] as? String {
        terminalBuffers[sessionId, default: ""] += chunk
      }
    case "terminal_exit":
      if let dict = payload as? [String: Any], let sessionId = dict["sessionId"] as? String {
        let exitCode = dict["exitCode"] as? Int
        terminalBuffers[sessionId, default: ""] += "\n\n[process exited\(exitCode.map { " with \($0)" } ?? "")]"
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
    guard let requestId, let completion = pending.removeValue(forKey: requestId) else { return }
    completion(result)
  }

  private func awaitResponse(requestId: String, send: () -> Void) async throws -> Any {
    try await withCheckedThrowingContinuation { continuation in
      pending[requestId] = { result in
        continuation.resume(with: result)
      }
      send()
    }
  }

  private func sendEnvelope(type: String, requestId: String?, payload: Any) {
    guard let socket else { return }
    guard let payloadData = try? JSONSerialization.data(withJSONObject: payload, options: []) else { return }

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

    guard let data = try? JSONSerialization.data(withJSONObject: envelope, options: []),
          let text = String(data: data, encoding: .utf8)
    else { return }

    socket.send(.string(text)) { error in
      if let error {
        Task { @MainActor in
          self.lastError = error.localizedDescription
          self.connectionState = .error
          self.setDomainStatus(SyncDomain.allCases, phase: .failed, error: error.localizedDescription)
          self.failPendingRequests(with: error)
          self.scheduleReconnectIfNeeded(after: self.reconnectDelay())
        }
      }
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
    let data = try JSONSerialization.data(withJSONObject: object, options: [])
    return try decoder.decode(T.self, from: data)
  }

  private func sendDecodableCommand<T: Decodable>(action: String, args: [String: Any] = [:], as type: T.Type) async throws -> T {
    try decode(try await sendCommand(action: action, args: args), as: type)
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
    let payload = try JSONSerialization.data(withJSONObject: args, options: [])
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
          _ = try await performCommandRequest(action: operation.action, args: args)
        case "file":
          _ = try await performFileRequest(action: operation.action, args: args)
        default:
          throw NSError(domain: "ADE", code: 13, userInfo: [NSLocalizedDescriptionKey: "Unknown queued operation type."])
        }
        queued.removeFirst()
        savePendingOperations(queued)
      } catch {
        lastError = error.localizedDescription
        connectionState = .error
        break
      }
    }
  }

  private func performCommandRequest(action: String, args: [String: Any]) async throws -> Any {
    guard canSendLiveRequests() else {
      throw NSError(domain: "ADE", code: 14, userInfo: [NSLocalizedDescriptionKey: "The host is offline."])
    }
    let requestId = makeRequestId()
    let raw = try await awaitResponse(requestId: requestId) {
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

  private func performInitialHydration() async {
    guard connectionState == .connected || connectionState == .syncing else { return }

    setDomainStatus(SyncDomain.allCases, phase: .syncingInitialData)

    do {
      try await InitialHydrationGate.waitForProjectRow(currentProjectId: { self.database.currentProjectId() })
    } catch {
      lastError = error.localizedDescription
      if connectionState == .disconnected || connectionState == .error {
        setDomainStatus(SyncDomain.allCases, phase: .disconnected)
      } else {
        setDomainStatus(SyncDomain.allCases, phase: .failed, error: error.localizedDescription)
      }
      return
    }

    do {
      try await refreshLaneSnapshots()
    } catch {
      lastError = error.localizedDescription
    }
    do {
      try await refreshWorkSessions()
    } catch {
      lastError = error.localizedDescription
    }
    do {
      try await refreshPullRequestSnapshots()
    } catch {
      lastError = error.localizedDescription
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

private final class SyncBonjourBrowser: NSObject, NetServiceBrowserDelegate, NetServiceDelegate {
  var onHostsChanged: (([DiscoveredSyncHost]) -> Void)?

  private let browser = NetServiceBrowser()
  private var services: [String: NetService] = [:]
  private var hosts: [String: DiscoveredSyncHost] = [:]
  private var isSearching = false

  override init() {
    super.init()
    browser.delegate = self
    browser.includesPeerToPeer = true
  }

  func start() {
    guard !isSearching else { return }
    isSearching = true
    browser.searchForServices(ofType: "_ade-sync._tcp.", inDomain: "local.")
  }

  func stop() {
    browser.stop()
    services.values.forEach { $0.stop() }
    services.removeAll()
    hosts.removeAll()
    isSearching = false
    publish()
  }

  func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
    let key = serviceKey(for: service)
    services[key] = service
    service.delegate = self
    service.resolve(withTimeout: 5)
    service.startMonitoring()
    if !moreComing {
      publish()
    }
  }

  func netServiceBrowser(_ browser: NetServiceBrowser, didRemove service: NetService, moreComing: Bool) {
    let key = serviceKey(for: service)
    services.removeValue(forKey: key)
    hosts.removeValue(forKey: key)
    if !moreComing {
      publish()
    }
  }

  func netServiceBrowser(_ browser: NetServiceBrowser, didNotSearch errorDict: [String : NSNumber]) {
    isSearching = false
  }

  func netServiceBrowserDidStopSearch(_ browser: NetServiceBrowser) {
    isSearching = false
  }

  func netServiceDidResolveAddress(_ sender: NetService) {
    updateHost(from: sender)
  }

  func netService(_ sender: NetService, didUpdateTXTRecord data: Data) {
    updateHost(from: sender)
  }

  func netService(_ sender: NetService, didNotResolve errorDict: [String : NSNumber]) {
    hosts.removeValue(forKey: serviceKey(for: sender))
    publish()
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
    let announcedAddresses = txtRecord["addresses"]?
      .split(separator: ",")
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) } ?? []
    let addresses = ((service.addresses?
      .compactMap(parseHost(from:))
      .filter { !$0.isEmpty } ?? []) + announcedAddresses)
    let port = service.port > 0 ? service.port : Int(txtRecord["port"] ?? "") ?? 8787
    let hostName = txtRecord["deviceName"] ?? service.hostName ?? service.name
    let hostIdentity = txtRecord["deviceId"]
    let id = hostIdentity ?? serviceKey(for: service)
    return DiscoveredSyncHost(
      id: id,
      serviceName: service.name,
      hostName: hostName,
      hostIdentity: hostIdentity,
      port: port,
      addresses: Array(Set(addresses)).sorted(),
      tailscaleAddress: txtRecord["tailscaleIp"],
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
