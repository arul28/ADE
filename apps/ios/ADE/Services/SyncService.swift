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

@MainActor
final class SyncService: ObservableObject {
  @Published private(set) var connectionState: RemoteConnectionState = .disconnected
  @Published private(set) var hostName: String?
  @Published private(set) var lastError: String?
  @Published private(set) var terminalBuffers: [String: String] = [:]
  @Published private(set) var pendingOperationCount = 0
  @Published private(set) var localStateRevision = 0
  @Published var settingsPresented = false

  private let draftKey = "ade.sync.connectionDraft"
  private let pendingOperationsKey = "ade.sync.pendingOperations"
  private let keychain = KeychainService()
  private let database: DatabaseService
  private var socket: URLSessionWebSocketTask?
  private var pending: [String: (Result<Any, Error>) -> Void] = [:]
  private let decoder = JSONDecoder()
  private let encoder = JSONEncoder()
  private let compressionThresholdBytes = 4 * 1024
  private var relayTask: Task<Void, Never>?
  private var databaseObserver: NSObjectProtocol?
  private var latestRemoteDbVersion = 0
  private var outboundLocalDbVersion = 0
  private(set) var deviceId: String

  private let queueableCommandActions: Set<String> = [
    "lanes.create",
    "lanes.archive",
    "lanes.unarchive",
    "work.runQuickCommand",
    "prs.createFromLane",
    "prs.land",
    "prs.close",
    "prs.requestReviewers",
  ]

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
    if let initializationError = database.initializationError {
      lastError = initializationError.localizedDescription
      connectionState = .error
    }

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
    if let databaseObserver {
      NotificationCenter.default.removeObserver(databaseObserver)
    }
  }

  func loadDraft() -> ConnectionDraft? {
    guard let data = UserDefaults.standard.data(forKey: draftKey) else { return nil }
    return try? decoder.decode(ConnectionDraft.self, from: data)
  }

  func reconnectIfPossible() async {
    do {
      try ensureDatabaseReady()
    } catch {
      lastError = error.localizedDescription
      connectionState = .error
      return
    }
    guard let draft = loadDraft(), let token = keychain.loadToken() else { return }
    do {
      try await openSocket(host: draft.host, port: draft.port)
      try await hello(host: draft.host, port: draft.port, token: token, authKind: draft.authKind, pairedDeviceId: draft.pairedDeviceId)
      await flushPendingOperations()
    } catch {
      lastError = error.localizedDescription
      connectionState = .error
    }
  }

  func pairAndConnect(host: String, port: Int, code: String) async {
    do {
      try ensureDatabaseReady()
    } catch {
      lastError = error.localizedDescription
      connectionState = .error
      return
    }
    do {
      try await openSocket(host: host, port: port)
      let requestId = makeRequestId()
      let raw = try await awaitResponse(requestId: requestId) {
        self.sendEnvelope(type: "pairing_request", requestId: requestId, payload: [
          "code": code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased(),
          "peer": self.currentPeerMetadata(),
        ])
      }
      guard let payload = raw as? [String: Any], (payload["ok"] as? Bool) == true else {
        throw NSError(domain: "ADE", code: 2, userInfo: [
          NSLocalizedDescriptionKey: ((raw as? [String: Any])?["error"] as? [String: Any])?["message"] as? String ?? "Pairing failed."
        ])
      }
      guard let secret = payload["secret"] as? String else {
        throw NSError(domain: "ADE", code: 3, userInfo: [NSLocalizedDescriptionKey: "Pairing secret missing from response."])
      }
      let pairedDeviceId = payload["deviceId"] as? String ?? deviceId
      keychain.saveToken(secret)
      let draft = ConnectionDraft(
        host: host,
        port: port,
        authKind: "paired",
        pairedDeviceId: pairedDeviceId,
        lastRemoteDbVersion: 0,
        lastBrainDeviceId: nil
      )
      saveDraft(draft)
      try await hello(host: host, port: port, token: secret, authKind: "paired", pairedDeviceId: pairedDeviceId)
      await flushPendingOperations()
    } catch {
      lastError = error.localizedDescription
      connectionState = .error
    }
  }

  func disconnect(clearCredentials: Bool = false) {
    relayTask?.cancel()
    relayTask = nil
    socket?.cancel(with: .normalClosure, reason: nil)
    socket = nil
    connectionState = .disconnected
    hostName = nil
    latestRemoteDbVersion = 0
    outboundLocalDbVersion = database.currentDbVersion()
    if clearCredentials {
      keychain.clearToken()
      saveDraft(nil)
    }
  }

  func refreshLaneSnapshots() async throws {
    _ = try await sendCommand(action: "lanes.refreshSnapshots", args: [
      "includeArchived": true,
      "includeStatus": true,
    ])
  }

  func refreshPullRequestSnapshots(prId: String? = nil) async throws {
    var args: [String: Any] = [:]
    if let prId {
      args["prId"] = prId
    }
    _ = try await sendCommand(action: "prs.refresh", args: args)
  }

  func fetchLanes(includeArchived: Bool = false) async throws -> [LaneSummary] {
    database.fetchLanes(includeArchived: includeArchived)
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

  func runQuickCommand(laneId: String, title: String, startupCommand: String) async throws {
    _ = try await sendCommand(action: "work.runQuickCommand", args: [
      "laneId": laneId,
      "title": title,
      "startupCommand": startupCommand,
    ])
  }

  func createLane(name: String, description: String) async throws {
    _ = try await sendCommand(action: "lanes.create", args: [
      "name": name,
      "description": description,
    ])
  }

  func archiveLane(_ laneId: String) async throws {
    _ = try await sendCommand(action: "lanes.archive", args: ["laneId": laneId])
  }

  func unarchiveLane(_ laneId: String) async throws {
    _ = try await sendCommand(action: "lanes.unarchive", args: ["laneId": laneId])
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

  func requestReviewers(prId: String, reviewers: [String]) async throws {
    _ = try await sendCommand(action: "prs.requestReviewers", args: [
      "prId": prId,
      "reviewers": reviewers,
    ])
  }

  private func saveDraft(_ draft: ConnectionDraft?) {
    if let draft, let data = try? encoder.encode(draft) {
      UserDefaults.standard.set(data, forKey: draftKey)
    } else {
      UserDefaults.standard.removeObject(forKey: draftKey)
    }
  }

  private func currentPeerMetadata() -> [String: Any] {
    [
      "deviceId": deviceId,
      "deviceName": UIDevice.current.name,
      "platform": "iOS",
      "deviceType": "phone",
      "siteId": database.localSiteId(),
      "dbVersion": database.currentDbVersion(),
    ]
  }

  private func openSocket(host: String, port: Int) async throws {
    disconnect()
    connectionState = .connecting
    guard let url = URL(string: "ws://\(host):\(port)") else {
      throw NSError(domain: "ADE", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid host address."])
    }
    let task = URLSession.shared.webSocketTask(with: url)
    task.resume()
    socket = task
    receiveLoop(for: task)
  }

  private func hello(host: String, port: Int, token: String, authKind: String, pairedDeviceId: String?) async throws {
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

    let draft = ConnectionDraft(
      host: host,
      port: port,
      authKind: authKind,
      pairedDeviceId: pairedDeviceId,
      lastRemoteDbVersion: payload["serverDbVersion"] as? Int ?? 0,
      lastBrainDeviceId: (payload["brain"] as? [String: Any])?["deviceId"] as? String
    )
    saveDraft(draft)
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
      if let dict = payload as? [String: Any] {
        latestRemoteDbVersion = dict["serverDbVersion"] as? Int ?? 0
        outboundLocalDbVersion = database.currentDbVersion()
        if let brain = dict["brain"] as? [String: Any] {
          hostName = brain["deviceName"] as? String
        }
        if var draft = loadDraft() {
          draft.lastRemoteDbVersion = latestRemoteDbVersion
          draft.lastBrainDeviceId = (dict["brain"] as? [String: Any])?["deviceId"] as? String
          saveDraft(draft)
        }
      }
      connectionState = .connected
      startRelayLoop()
      Task { @MainActor in
        try? await self.refreshLaneSnapshots()
        try? await self.refreshPullRequestSnapshots()
        await self.flushPendingOperations()
      }
      resolve(requestId: requestId, result: .success(payload))
    case "hello_error":
      let message = ((payload as? [String: Any])?["message"] as? String) ?? "Authentication failed."
      connectionState = .error
      resolve(requestId: requestId, result: .failure(NSError(domain: "ADE", code: 5, userInfo: [NSLocalizedDescriptionKey: message])))
    case "pairing_result":
      resolve(requestId: requestId, result: .success(payload))
    case "changeset_batch":
      connectionState = .syncing
      let batch = try decode(payload, as: SyncChangesetBatchPayload.self)
      let result = try database.applyChanges(batch.changes)
      latestRemoteDbVersion = max(latestRemoteDbVersion, batch.toDbVersion, result.dbVersion)
      if var draft = loadDraft() {
        draft.lastRemoteDbVersion = latestRemoteDbVersion
        saveDraft(draft)
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
    outboundLocalDbVersion = currentDbVersion
    guard !changes.isEmpty else { return }

    let payload = SyncChangesetBatchPayload(
      reason: "relay",
      fromDbVersion: latestRemoteDbVersion,
      toDbVersion: latestRemoteDbVersion,
      changes: changes
    )
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
    return try await awaitResponse(requestId: requestId) {
      self.sendEnvelope(type: "command", requestId: requestId, payload: [
        "commandId": requestId,
        "action": action,
        "args": args,
      ])
    }
  }

  private func sendCommand(action: String, args: [String: Any]) async throws -> Any {
    if canSendLiveRequests() {
      return try await performCommandRequest(action: action, args: args)
    }
    guard queueableCommandActions.contains(action) else {
      throw NSError(domain: "ADE", code: 15, userInfo: [NSLocalizedDescriptionKey: "This action requires a live connection to the host."])
    }
    try enqueueOperation(kind: "command", action: action, args: args)
    return ["queued": true]
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
