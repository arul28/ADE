import Foundation
import OSLog

private let machineConnectionLog = Logger(subsystem: "com.ade.ios", category: "fleet")

/// One light "roster" connection to a paired machine that is NOT the focused
/// machine. It never replicates the project database and never switches the
/// machine's project: it keeps the machine-wide roster live (every project's
/// lanes and chats), streams the chats the user opens from it, and sends
/// commands for those chats. The focused machine's full connection stays in
/// `SyncService`.
///
/// Rules this class relies on (see `.ade/plans/phase-2-3-design.md`):
/// - The host keeps one socket per phone per machine, and a newer hello closes
///   the older one. `SyncService.fleetBlockedMachineKeys` and
///   `fleetHelloOnHold` are checked right before the hello is sent, so a roster
///   hello never reaches the focused machine.
/// - The hello says `syncRole: "roster"`. A host that does not advertise the
///   `rosterPeer` feature would replicate its database to this socket, so the
///   connection closes at once and the machine shows "update ADE".
@MainActor
final class MachineConnection {
  enum Phase: Equatable {
    /// Not running (paused by the fleet, the app is in the background, or the
    /// machine is focused).
    case idle
    case connecting
    case live
    /// Could not reach the machine; retrying with backoff, or waiting for a
    /// retry trigger once `gaveUp` (see `resumeAfterGivingUp`).
    case offline(message: String?)
    /// The machine runs an ADE version without roster-only peers.
    case needsUpdate
    /// The pairing or the account needs the user; no automatic retry.
    case needsAttention(message: String)
  }

  let machineKey: String
  private(set) var profile: HostConnectionProfile
  private(set) var phase: Phase = .idle
  private(set) var rosterProjects: [RemoteRosterProject]
  private(set) var rosterRevision = 0
  /// Wall time of the last frame from this machine (drives "last update").
  private(set) var lastUpdateAt: Date?
  private(set) var supportsChatStreaming = false
  private(set) var supportsChatLogV2 = false
  private(set) var supportsChatHistoryPaging = false
  private(set) var supportsChatHistoryPageBySequence = false
  private(set) var commandDescriptors: [SyncRemoteCommandDescriptor] = []
  /// Host display name from the last hello.
  private(set) var hostName: String?

  /// Called after any change the fleet publishes (phase, roster, name).
  var onChange: (() -> Void)?

  private weak var syncService: SyncService?
  private let registry: ChatThreadRegistry
  private var runTask: Task<Void, Never>?
  private var socket: URLSessionWebSocketTask?
  /// Bumped on every start/stop and every new socket; stale work compares it.
  private var generation: UInt64 = 0
  private var pending: [String: PendingRequest] = [:]
  private var chunkAssembler = SyncEnvelopeChunkAssembler()
  private var compressionCodec: SyncWireCompressionCodec?
  private var compressionThresholdBytes = syncApplicationCompressionThresholdBytes
  private var chunkedEnvelopes = false
  private var maxFrameBytes = syncDefaultMaxFrameBytes
  private var rosterSeq: Int?
  private var rosterPersistTask: Task<Void, Never>?
  private var heartbeatTask: Task<Void, Never>?
  private var lastInboundUptime: TimeInterval = 0
  private var consecutiveFailures = 0
  /// The backoff ran out: no more dials until the user retries, the app opens,
  /// the network changes, or the account shows the machine online.
  private(set) var gaveUp = false
  /// Chats opened on this machine: session id -> foreign project scope.
  private var chatScopes: [String: (projectId: String, rootPath: String)] = [:]
  private var chatLastSeq: [String: Int] = [:]
  private var snapshotWatchdogs: [String: Task<Void, Never>] = [:]
  private(set) var stalledChatSessionIds: Set<String> = []
  private(set) var pendingSnapshotSessionIds: Set<String> = []

  private struct PendingRequest {
    let continuation: CheckedContinuation<Any, Error>
    let timeoutTask: Task<Void, Never>
  }

  /// App Group key of this machine's offline roster (shared with the focused
  /// connection's cache for the same machine).
  private let rosterCacheKey: String?

  init(
    machineKey: String,
    profile: HostConnectionProfile,
    syncService: SyncService,
    registry: ChatThreadRegistry
  ) {
    self.machineKey = machineKey
    self.profile = profile
    self.syncService = syncService
    self.registry = registry
    let cacheKey = syncService.fleetRosterCacheKey(for: profile)
    self.rosterCacheKey = cacheKey
    self.rosterProjects = cacheKey.map(MachineConnection.loadCachedRoster(cacheKey:)) ?? []
    self.hostName = nonEmptyTrimmed(profile.hostName)
  }

  var isLive: Bool { phase == .live && socket != nil }
  var isRunning: Bool { runTask != nil }

  func updateProfile(_ profile: HostConnectionProfile) {
    self.profile = profile
  }

  // MARK: - Lifecycle

  func start() {
    guard runTask == nil, !gaveUp else { return }
    if case .needsAttention = phase { return }
    generation &+= 1
    let runGeneration = generation
    runTask = Task { @MainActor [weak self] in
      await self?.run(generation: runGeneration)
    }
  }

  /// Stop and close the socket. `clearAttention` lets a user retry a machine
  /// that needed attention.
  func stop(reason: String, clearAttention: Bool = false) {
    generation &+= 1
    runTask?.cancel()
    runTask = nil
    closeSocket(reason: reason)
    if clearAttention {
      gaveUp = false
      consecutiveFailures = 0
    }
    if clearAttention || !isAttentionPhase, !gaveUp {
      setPhase(.idle)
    }
  }

  /// Let a connection that ran out of retries dial again (the caller starts
  /// it). A no-op for any other connection.
  func resumeAfterGivingUp() {
    guard gaveUp else { return }
    gaveUp = false
    consecutiveFailures = 0
    setPhase(.idle)
  }

  private var isAttentionPhase: Bool {
    if case .needsAttention = phase { return true }
    return false
  }

  private func run(generation runGeneration: UInt64) async {
    while !Task.isCancelled, generation == runGeneration {
      guard let syncService else { return }
      guard mayDial(syncService) else {
        // The focused connection holds this machine (or has a socket whose
        // machine is not known yet). Wait for the fleet to decide.
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        continue
      }
      guard let token = syncService.fleetToken(for: profile) else {
        setPhase(.needsAttention(message: "Pair this machine again from Settings."))
        runTask = nil
        return
      }
      if phase != .live { setPhase(.connecting) }
      let dialGeneration = generation
      do {
        let result = try await syncService.dialFleetConnection(
          profile: profile,
          token: token,
          isCurrent: { [weak self] in
            guard let self, let service = self.syncService else { return false }
            return self.generation == dialGeneration && self.mayDial(service)
          }
        )
        guard generation == dialGeneration, !Task.isCancelled else {
          result.task.cancel(with: .goingAway, reason: nil)
          return
        }
        guard attach(result) else {
          // Old host: closes at once and does not retry until the app restarts
          // the fleet (a machine update changes its hello).
          runTask = nil
          return
        }
        consecutiveFailures = 0
        await receiveLoop(for: result.task, generation: dialGeneration)
        guard generation == dialGeneration, !Task.isCancelled else { return }
        closeSocket(reason: "Connection closed.")
        setPhase(.offline(message: nil))
      } catch is CancellationError {
        guard generation == dialGeneration, !Task.isCancelled else { return }
      } catch let requirement as SyncRelayAuthorizationRequirement {
        setPhase(.needsAttention(message: SyncUserFacingError.message(for: requirement)))
        runTask = nil
        return
      } catch {
        guard generation == dialGeneration, !Task.isCancelled else { return }
        if syncService.fleetErrorIsPairingRejection(error) {
          setPhase(.needsAttention(message: SyncUserFacingError.message(for: error)))
          runTask = nil
          return
        }
        setPhase(.offline(message: SyncUserFacingError.message(for: error)))
      }
      consecutiveFailures += 1
      guard let delay = machineConnectionBackoffNanoseconds(failures: consecutiveFailures) else {
        machineConnectionLog.notice("fleet gives up machine=\(self.machineKey, privacy: .public) failures=\(self.consecutiveFailures)")
        gaveUp = true
        runTask = nil
        onChange?()
        return
      }
      try? await Task.sleep(nanoseconds: delay)
    }
  }

  private func mayDial(_ syncService: SyncService) -> Bool {
    !syncService.fleetHelloOnHold && !syncService.fleetBlockedMachineKeys.contains(machineKey)
  }

  /// Apply `hello_ok`. Returns false when the host cannot serve a roster peer.
  private func attach(_ result: SyncFleetDialResult) -> Bool {
    let payload = result.helloPayload
    let negotiation = SyncHelloNegotiation(helloPayload: payload)
    let features = negotiation.features
    func featureEnabled(_ keys: String...) -> Bool { negotiation.featureEnabled(keys) }
    guard featureEnabled("rosterPeer", "roster_peer") else {
      machineConnectionLog.notice("fleet host lacks rosterPeer machine=\(self.machineKey, privacy: .public)")
      result.task.cancel(with: .goingAway, reason: nil)
      setPhase(.needsUpdate)
      return false
    }
    supportsChatStreaming = featureEnabled("chatStreaming", "chat_streaming")
    supportsChatHistoryPaging = featureEnabled("chatHistoryPaging", "chat_history_paging")
    supportsChatLogV2 = featureEnabled("chatLogV2", "chat_log_v2")
    supportsChatHistoryPageBySequence = featureEnabled("chatHistoryPageBySequence", "chat_history_page_by_sequence")
    chunkedEnvelopes = negotiation.chunkedMaxFrameBytes != nil
    maxFrameBytes = negotiation.chunkedMaxFrameBytes ?? syncDefaultMaxFrameBytes
    compressionCodec = negotiation.deflateThresholdBytes != nil ? .deflate : nil
    compressionThresholdBytes = negotiation.deflateThresholdBytes ?? syncApplicationCompressionThresholdBytes
    if let routing = features?["commandRouting"] as? [String: Any],
       let actions = routing["actions"],
       let data = try? JSONSerialization.data(withJSONObject: actions),
       let descriptors = try? JSONDecoder().decode([SyncRemoteCommandDescriptor].self, from: data) {
      commandDescriptors = descriptors
    } else {
      commandDescriptors = []
    }
    if let brain = payload["brain"] as? [String: Any],
       let name = nonEmptyTrimmed(brain["deviceName"] as? String) {
      hostName = name
    }
    chunkAssembler = SyncEnvelopeChunkAssembler()
    socket = result.task
    lastInboundUptime = ProcessInfo.processInfo.systemUptime
    lastUpdateAt = Date()
    setPhase(.live)
    startHeartbeat(
      intervalNanoseconds: syncClientHeartbeatIntervalNanoseconds(serverIntervalMs: payload["heartbeatIntervalMs"]),
      generation: generation
    )
    subscribeRoster()
    restoreChatSubscriptions()
    machineConnectionLog.notice(
      "fleet live machine=\(self.machineKey, privacy: .public) address=\(result.address, privacy: .public)"
    )
    return true
  }

  private func closeSocket(reason: String) {
    heartbeatTask?.cancel()
    heartbeatTask = nil
    for (_, task) in snapshotWatchdogs { task.cancel() }
    snapshotWatchdogs.removeAll()
    pendingSnapshotSessionIds.removeAll()
    if let socket {
      socket.cancel(with: .goingAway, reason: reason.data(using: .utf8))
    }
    socket = nil
    // The roster subscription belongs to the socket; keep the rows for the
    // offline view and ask for a fresh snapshot on the next socket.
    rosterSeq = nil
    let error = NSError(domain: "ADE", code: 14, userInfo: [NSLocalizedDescriptionKey: "Can’t reach this computer right now."])
    let requests = pending
    pending.removeAll()
    for (_, request) in requests {
      request.timeoutTask.cancel()
      request.continuation.resume(throwing: error)
    }
  }

  private func setPhase(_ next: Phase) {
    guard phase != next else { return }
    ScrollDiagnostics.shared.event("fleet.phase", [
      "machine": machineKey,
      "phase": String(describing: next).prefix(160).description,
    ])
    phase = next
    onChange?()
  }

  // MARK: - Receive

  private func receiveLoop(for task: URLSessionWebSocketTask, generation loopGeneration: UInt64) async {
    while socket === task, generation == loopGeneration, !Task.isCancelled {
      let message: URLSessionWebSocketTask.Message
      do {
        message = try await task.receive()
      } catch {
        return
      }
      guard socket === task, generation == loopGeneration else { return }
      var binaryFrame: Data?
      let text: String
      switch message {
      case .string(let value):
        text = value
      case .data(let data):
        if SyncBinaryFrame.isBinaryFrame(data) {
          binaryFrame = data
          text = ""
        } else {
          text = String(decoding: data, as: UTF8.self)
        }
      @unknown default:
        text = ""
      }
      lastInboundUptime = ProcessInfo.processInfo.systemUptime
      if binaryFrame == nil,
         let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)),
         syncRelayTransportControl(from: object) != nil {
        continue
      }
      do {
        let frame = binaryFrame
        let preprocessed = try await Task.detached(priority: .utility) {
          if let frame { return try syncPreprocessIncomingData(frame) }
          return try syncPreprocessIncoming(text)
        }.value
        guard socket === task, generation == loopGeneration else { return }
        if let preprocessed {
          await handle(preprocessed, generation: loopGeneration)
        }
      } catch {
        machineConnectionLog.error(
          "fleet frame failed machine=\(self.machineKey, privacy: .public) error=\(String(describing: error), privacy: .public)"
        )
        return
      }
    }
  }

  private func handle(_ pre: SyncPreprocessedEnvelope, generation frameGeneration: UInt64) async {
    let payload = pre.payload
    switch pre.type {
    case "envelope_chunk":
      let reassembled: Data?
      if let binaryChunk = pre.binaryChunk {
        reassembled = chunkAssembler.addBinary(
          chunkId: binaryChunk.chunkId,
          index: binaryChunk.index,
          total: binaryChunk.total,
          part: binaryChunk.part
        )
      } else {
        guard let dict = payload as? [String: Any],
              let chunkId = dict["chunkId"] as? String,
              let index = dict["index"] as? Int,
              let total = dict["total"] as? Int,
              let part = dict["part"] as? String else { return }
        reassembled = chunkAssembler.add(chunkId: chunkId, index: index, total: total, part: part)
          .map { Data($0.utf8) }
      }
      chunkAssembler.expireStale()
      guard let reassembled,
            let nested = try? await Task.detached(priority: .utility, operation: {
              try syncPreprocessIncomingData(reassembled)
            }).value,
            generation == frameGeneration
      else { return }
      await handle(nested, generation: frameGeneration)
    case "heartbeat":
      if let dict = payload as? [String: Any], (dict["kind"] as? String) == "ping" {
        send(type: "heartbeat", requestId: pre.requestId, payload: [
          "kind": "pong",
          "sentAt": dict["sentAt"] as? String ?? ISO8601DateFormatter().string(from: Date()),
          "dbVersion": 0,
        ])
      }
    case "command_ack":
      if let dict = payload as? [String: Any], let accepted = dict["accepted"] as? Bool, !accepted {
        let message = dict["message"] as? String ?? "Remote command rejected."
        resolve(requestId: pre.requestId, result: .failure(NSError(domain: "ADE", code: 6, userInfo: [NSLocalizedDescriptionKey: message])))
      }
    case "command_result", "chat_history", "chat_tool_result", "file_response":
      resolve(requestId: pre.requestId, result: .success(payload))
    case "roster_snapshot":
      guard let snapshot = machineConnectionDecode(payload, as: RemoteRosterSnapshotPayload.self) else { return }
      applyRosterSnapshot(snapshot)
    case "roster_delta":
      guard let delta = machineConnectionDecode(payload, as: RemoteRosterDeltaPayload.self) else { return }
      applyRosterDelta(delta)
    case "chat_subscribe":
      await handleChatSnapshot(payload, generation: frameGeneration)
    case "chat_event":
      await handleChatEvent(payload, generation: frameGeneration)
    default:
      // Changesets, catalogs, terminals and anything else are not for a
      // roster peer. Hosts that know `syncRole: "roster"` never send them.
      break
    }
    lastUpdateAt = Date()
  }

  // MARK: - Requests

  @discardableResult
  private func send(type: String, requestId: String?, payload: Any, projectId: String? = nil) -> Bool {
    guard let socket else { return false }
    guard let frames = try? syncEncodeEnvelopeFrames(
      type: type,
      requestId: requestId,
      projectId: projectId,
      payload: payload,
      compressionCodec: compressionCodec ?? .gzip,
      compressionThresholdBytes: compressionThresholdBytes,
      chunkedEnvelopes: chunkedEnvelopes,
      maxFrameBytes: maxFrameBytes
    ) else { return false }
    let sendGeneration = generation
    for frame in frames {
      socket.send(.string(frame)) { [weak self] error in
        guard error != nil else { return }
        Task { @MainActor [weak self] in
          guard let self, self.generation == sendGeneration, self.socket === socket else { return }
          self.closeSocket(reason: "Send failed.")
          self.setPhase(.offline(message: nil))
        }
      }
    }
    return true
  }

  private func request(
    type: String,
    payload: [String: Any],
    requestId: String = UUID().uuidString,
    projectId: String? = nil,
    timeoutNanoseconds: UInt64,
    timeoutMessage: String
  ) async throws -> Any {
    guard socket != nil, phase == .live else {
      throw NSError(domain: "ADE", code: 14, userInfo: [NSLocalizedDescriptionKey: "Can’t reach this computer right now."])
    }
    return try await withCheckedThrowingContinuation { continuation in
      let timeoutTask = Task { @MainActor [weak self] in
        try? await Task.sleep(nanoseconds: timeoutNanoseconds)
        guard !Task.isCancelled else { return }
        self?.resolve(requestId: requestId, result: .failure(SyncRequestTimeout.error(message: timeoutMessage)))
      }
      pending[requestId] = PendingRequest(continuation: continuation, timeoutTask: timeoutTask)
      if !send(type: type, requestId: requestId, payload: payload, projectId: projectId) {
        resolve(requestId: requestId, result: .failure(NSError(
          domain: "ADE",
          code: 14,
          userInfo: [NSLocalizedDescriptionKey: "Can’t reach this computer right now."]
        )))
      }
    }
  }

  private func resolve(requestId: String?, result: Result<Any, Error>) {
    guard let requestId, let request = pending.removeValue(forKey: requestId) else { return }
    request.timeoutTask.cancel()
    request.continuation.resume(with: result)
  }

  /// Run a remote command on this machine, scoped to a project. Never queued:
  /// a command for another machine must not replay later to a different one.
  func sendCommand(
    action: String,
    args: [String: Any],
    projectId: String?,
    projectRootPath: String?,
    timeoutNanoseconds: UInt64? = nil
  ) async throws -> Any {
    let commandId = UUID().uuidString
    let raw = try await request(
      type: "command",
      payload: syncCommandEnvelopePayload(
        commandId: commandId,
        action: action,
        args: args,
        projectId: projectId,
        projectRootPath: projectRootPath
      ),
      requestId: commandId,
      timeoutNanoseconds: timeoutNanoseconds ?? SyncRequestTimeout.commandTimeoutNanoseconds(for: action),
      timeoutMessage: SyncRequestTimeout.message
    )
    return try unwrapSyncCommandResponse(raw)
  }

  /// A `file_request` on this machine. `projectId` names the project whose
  /// files are read (a lane's checkout); nil reads the machine's sync project
  /// (artifacts of its chats).
  func fileRequest(action: String, args: [String: Any], projectId: String? = nil) async throws -> Any {
    let raw = try await request(
      type: "file_request",
      payload: ["action": action, "args": args],
      projectId: projectId,
      timeoutNanoseconds: SyncRequestTimeout.defaultTimeoutNanoseconds,
      timeoutMessage: SyncRequestTimeout.message
    )
    if let response = raw as? [String: Any], let ok = response["ok"] as? Bool, ok == false {
      let message = (response["error"] as? [String: Any])?["message"] as? String ?? "File request failed."
      throw NSError(domain: "ADE", code: 8, userInfo: [NSLocalizedDescriptionKey: message])
    }
    if let response = raw as? [String: Any], let result = response["result"] {
      return result
    }
    return raw
  }

  func supportsAction(_ action: String) -> Bool {
    commandDescriptors.contains { $0.action == action }
  }

  // MARK: - Heartbeat

  private func startHeartbeat(intervalNanoseconds: UInt64, generation heartbeatGeneration: UInt64) {
    heartbeatTask?.cancel()
    heartbeatTask = Task { @MainActor [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: intervalNanoseconds)
        guard let self, !Task.isCancelled, self.generation == heartbeatGeneration, self.socket != nil else { return }
        let silence = ProcessInfo.processInfo.systemUptime - self.lastInboundUptime
        let interval = TimeInterval(intervalNanoseconds) / 1_000_000_000
        if silence > interval * 3 {
          // Nothing (not even a host ping) for three intervals: the path is
          // dead. Close; the run loop reconnects with backoff.
          machineConnectionLog.notice("fleet heartbeat silence machine=\(self.machineKey, privacy: .public)")
          self.socket?.cancel(with: .goingAway, reason: nil)
          return
        }
        if silence >= interval {
          self.send(type: "heartbeat", requestId: nil, payload: [
            "kind": "ping",
            "sentAt": ISO8601DateFormatter().string(from: Date()),
            "dbVersion": 0,
          ])
        }
      }
    }
  }

  // MARK: - Roster

  private func subscribeRoster() {
    var payload: [String: Any] = [:]
    if let rosterSeq { payload["sinceSeq"] = rosterSeq }
    send(type: "roster_subscribe", requestId: nil, payload: payload)
  }

  /// Ask for a fresh roster snapshot (after an action on this machine).
  func requestRosterSnapshot() {
    guard isLive else { return }
    rosterSeq = nil
    send(type: "roster_subscribe", requestId: nil, payload: [:])
  }

  private func applyRosterSnapshot(_ snapshot: RemoteRosterSnapshotPayload) {
    let next = snapshot.projects.map { $0.excludingIdentityChats() }
    rosterSeq = snapshot.seq
    if next != rosterProjects {
      rosterProjects = next
      rosterRevision &+= 1
      schedulePersistRoster()
      onChange?()
    }
    applyRosterFreshness(next)
  }

  private func applyRosterDelta(_ delta: RemoteRosterDeltaPayload) {
    switch rosterApplyDelta(current: rosterProjects, currentSeq: rosterSeq, delta: delta) {
    case .needsSnapshot:
      rosterSeq = nil
      send(type: "roster_subscribe", requestId: nil, payload: [:])
    case .dropped:
      break
    case let .applied(projects, seq):
      rosterSeq = seq
      let byId = Dictionary(projects.map { ($0.projectId, $0) }, uniquingKeysWith: { first, _ in first })
      // Keep the previous order stable; new projects go last.
      var next: [RemoteRosterProject] = rosterProjects.compactMap { byId[$0.projectId] }
      let known = Set(next.map(\.projectId))
      next.append(contentsOf: projects.filter { !known.contains($0.projectId) })
      if next != rosterProjects {
        rosterProjects = next
        rosterRevision &+= 1
        schedulePersistRoster()
        onChange?()
      }
      applyRosterFreshness(delta.changed ?? [])
    }
  }

  private func applyRosterFreshness(_ projects: [RemoteRosterProject]) {
    guard supportsChatLogV2 else { return }
    var generations: [String: Int] = [:]
    for project in projects {
      for chat in project.chats {
        if let generation = chat.historyGeneration { generations[chat.id] = generation }
      }
    }
    registry.applyRosterFreshness(machineKey: machineKey, generationBySessionId: generations)
  }

  static func loadCachedRoster(cacheKey: String) -> [RemoteRosterProject] {
    guard let data = ADESharedContainer.defaults.data(forKey: cacheKey),
          let projects = try? JSONDecoder().decode([RemoteRosterProject].self, from: data)
    else { return [] }
    return projects.map { $0.excludingIdentityChats() }
  }

  private func schedulePersistRoster() {
    rosterPersistTask?.cancel()
    guard let key = rosterCacheKey else { return }
    let snapshot = rosterProjects
    rosterPersistTask = Task { @MainActor in
      try? await Task.sleep(nanoseconds: 600_000_000)
      guard !Task.isCancelled, let data = try? JSONEncoder().encode(snapshot) else { return }
      ADESharedContainer.defaults.set(data, forKey: key)
    }
  }

  // MARK: - Chats

  func chatThreadKey(sessionId: String) -> ChatThreadKey? {
    guard let scope = chatScopes[sessionId] else { return nil }
    return ChatThreadKey(
      machineKey: machineKey,
      sessionId: sessionId,
      scope: .crossProject(projectId: scope.projectId, rootPath: scope.rootPath)
    )
  }

  func isChatSubscribed(_ sessionId: String) -> Bool {
    chatScopes[sessionId] != nil
  }

  func chatSubscriptionIsLive(_ sessionId: String) -> Bool {
    isLive && supportsChatStreaming && chatScopes[sessionId] != nil
  }

  /// Open (or re-snapshot) a chat on this machine. `projectId`/`rootPath` name
  /// the chat's project on this machine.
  @discardableResult
  func subscribeChat(
    sessionId: String,
    projectId: String,
    rootPath: String,
    requestSnapshot: Bool
  ) -> Bool {
    let wasSubscribed = chatScopes[sessionId] != nil
    chatScopes[sessionId] = (projectId, rootPath)
    guard isLive, supportsChatStreaming else { return false }
    if wasSubscribed, !requestSnapshot { return true }
    return sendChatSubscribe(sessionId: sessionId, requestSnapshot: requestSnapshot || !wasSubscribed)
  }

  func unsubscribeChat(sessionId: String) {
    guard let scope = chatScopes.removeValue(forKey: sessionId) else { return }
    chatLastSeq.removeValue(forKey: sessionId)
    snapshotWatchdogs.removeValue(forKey: sessionId)?.cancel()
    pendingSnapshotSessionIds.remove(sessionId)
    stalledChatSessionIds.remove(sessionId)
    guard isLive else { return }
    // The host matches the scope of the subscription it drops.
    var payload: [String: Any] = ["sessionId": sessionId, "projectId": scope.projectId]
    if !scope.rootPath.isEmpty { payload["projectRootPath"] = scope.rootPath }
    send(type: "chat_unsubscribe", requestId: nil, payload: payload)
  }

  private func restoreChatSubscriptions() {
    guard supportsChatStreaming else { return }
    for sessionId in chatScopes.keys.sorted() {
      sendChatSubscribe(sessionId: sessionId, requestSnapshot: false)
    }
  }

  @discardableResult
  private func sendChatSubscribe(sessionId: String, requestSnapshot: Bool) -> Bool {
    guard let scope = chatScopes[sessionId] else { return false }
    var payload: [String: Any] = [
      "sessionId": sessionId,
      "maxBytes": syncChatSubscriptionMaxBytes,
      "projectId": scope.projectId,
    ]
    if !scope.rootPath.isEmpty { payload["projectRootPath"] = scope.rootPath }
    let resumePoint = chatThreadKey(sessionId: sessionId).flatMap { registry.resumePoint(for: $0) }
    for (field, value) in chatThreadSubscribeResumeFields(
      hostSupportsChatLogV2: supportsChatLogV2,
      includeResume: !requestSnapshot,
      resumePoint: resumePoint,
      legacySinceSeq: chatLastSeq[sessionId]
    ) {
      payload[field] = value
    }
    guard send(type: "chat_subscribe", requestId: nil, payload: payload) else { return false }
    if requestSnapshot {
      pendingSnapshotSessionIds.insert(sessionId)
      stalledChatSessionIds.remove(sessionId)
      startSnapshotWatchdog(sessionId: sessionId, attempt: 0)
    }
    return true
  }

  func requestChatSnapshot(sessionId: String) {
    guard chatScopes[sessionId] != nil else { return }
    stalledChatSessionIds.remove(sessionId)
    sendChatSubscribe(sessionId: sessionId, requestSnapshot: true)
  }

  private func startSnapshotWatchdog(sessionId: String, attempt: Int) {
    snapshotWatchdogs.removeValue(forKey: sessionId)?.cancel()
    let watchdogGeneration = generation
    snapshotWatchdogs[sessionId] = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: 10_000_000_000)
      guard let self, !Task.isCancelled, self.generation == watchdogGeneration,
            self.pendingSnapshotSessionIds.contains(sessionId) else { return }
      self.snapshotWatchdogs.removeValue(forKey: sessionId)
      if attempt < 2, self.isLive {
        self.sendChatSubscribe(sessionId: sessionId, requestSnapshot: true)
        self.startSnapshotWatchdog(sessionId: sessionId, attempt: attempt + 1)
        return
      }
      self.pendingSnapshotSessionIds.remove(sessionId)
      self.stalledChatSessionIds.insert(sessionId)
      if let key = self.chatThreadKey(sessionId: sessionId) {
        self.registry.markSnapshotStalled(key, message: nil)
      }
      self.onChange?()
    }
  }

  private func handleChatSnapshot(_ payload: Any, generation frameGeneration: UInt64) async {
    guard supportsChatStreaming,
          let dict = payload as? [String: Any],
          let sessionId = dict["sessionId"] as? String,
          chatScopes[sessionId] != nil
    else { return }
    let hostSupportsChatLogV2 = supportsChatLogV2
    let decoded = await Task.detached(priority: .userInitiated) {
      chatThreadDecodeSnapshot(dict, hostSupportsChatLogV2: hostSupportsChatLogV2)
    }.value
    guard let decoded, generation == frameGeneration, chatScopes[sessionId] != nil,
          let key = chatThreadKey(sessionId: sessionId)
    else { return }
    registry.routeSnapshot(decoded, key: key)
    pendingSnapshotSessionIds.remove(sessionId)
    snapshotWatchdogs.removeValue(forKey: sessionId)?.cancel()
    stalledChatSessionIds.remove(sessionId)
    if !decoded.resumed || decoded.resumeKind == "sequence" {
      chatLastSeq.removeValue(forKey: sessionId)
    }
  }

  private func handleChatEvent(_ payload: Any, generation frameGeneration: UInt64) async {
    guard supportsChatStreaming,
          let dict = payload as? [String: Any],
          let sessionId = dict["sessionId"] as? String,
          chatScopes[sessionId] != nil
    else { return }
    let seq = (dict["seq"] as? NSNumber)?.intValue
    if let seq, let lastSeq = chatLastSeq[sessionId], seq <= lastSeq { return }
    let decoded = await Task.detached(priority: .userInitiated) {
      chatThreadDecodeLiveEvent(dict)
    }.value
    guard let decoded, generation == frameGeneration, chatScopes[sessionId] != nil,
          let key = chatThreadKey(sessionId: sessionId)
    else { return }
    if let seq { chatLastSeq[sessionId] = seq }
    registry.routeLive(decoded, key: key)
  }

  /// One older page for a chat on this machine.
  func fetchOlderPage(
    sessionId: String,
    request olderRequest: ChatThreadOlderRequest
  ) async throws -> ChatThreadOlderPageInput {
    guard let scope = chatScopes[sessionId] else {
      throw NSError(domain: "ADE", code: 27, userInfo: [NSLocalizedDescriptionKey: "Open the chat to load earlier messages."])
    }
    var payload: [String: Any] = [
      "sessionId": sessionId,
      "maxBytes": syncChatHistoryTailPageMaxBytes,
      "projectId": scope.projectId,
    ]
    if !scope.rootPath.isEmpty { payload["projectRootPath"] = scope.rootPath }
    if supportsChatLogV2 { payload["chatLogV2"] = true }
    switch olderRequest {
    case .beforeSequence(let sequence): payload["beforeSequence"] = sequence
    case .beforeOffset(let offset): payload["beforeOffset"] = max(0, offset)
    }
    let commandCanPage: Bool = {
      switch olderRequest {
      case .beforeOffset: return true
      case .beforeSequence: return supportsChatHistoryPageBySequence
      }
    }()
    do {
      let raw = try await request(
        type: "chat_history",
        payload: payload,
        timeoutNanoseconds: 8_000_000_000,
        timeoutMessage: "Timed out loading earlier chat messages."
      )
      let decoded = try await decodeOlderPage(raw, sessionId: sessionId)
      guard decoded.unavailable, commandCanPage else { return decoded }
    } catch where isSyncRequestTimeoutError(error) && commandCanPage {
      // A handler that never answers `chat_history` falls through as well.
    }
    // The socket handler cannot serve this chat's history; the command can.
    var args: [String: Any] = ["sessionId": sessionId, "maxBytes": syncChatHistoryTailPageMaxBytes]
    switch olderRequest {
    case .beforeSequence(let sequence): args["beforeSequence"] = sequence
    case .beforeOffset(let offset): args["beforeOffset"] = offset
    }
    let commandRaw = try await sendCommand(
      action: "chat.getChatEventHistoryPage",
      args: args,
      projectId: scope.projectId,
      projectRootPath: scope.rootPath.isEmpty ? nil : scope.rootPath,
      timeoutNanoseconds: 8_000_000_000
    )
    return try await decodeOlderPage(commandRaw, sessionId: sessionId)
  }

  private func decodeOlderPage(_ raw: Any, sessionId: String) async throws -> ChatThreadOlderPageInput {
    let decoded = await Task.detached(priority: .userInitiated) {
      chatThreadDecodeOlderPage(raw, requestedSessionId: sessionId)
    }.value
    guard let decoded else {
      throw NSError(domain: "ADE", code: 28, userInfo: [NSLocalizedDescriptionKey: "Could not read earlier chat messages."])
    }
    return decoded
  }
}

// MARK: - Pure helpers

/// Waits before each retry of a machine that does not answer.
private let machineConnectionRetryDelaysSeconds: [Double] = [5, 15, 60, 300]

/// The wait before the next dial after `failures` failures in a row, with
/// jitter: 5 s, 15 s, 1 min, 5 min. Nil once those run out: the machine then
/// shows "Offline · Tap to retry" and is not dialed again until a retry
/// trigger. A switched-off machine used to cost a dial every 5 minutes for as
/// long as the app was open.
func machineConnectionBackoffNanoseconds(failures: Int, jitter: Double = Double.random(in: 0.8...1.2)) -> UInt64? {
  let index = max(failures, 1) - 1
  guard index < machineConnectionRetryDelaysSeconds.count else { return nil }
  return UInt64(machineConnectionRetryDelaysSeconds[index] * jitter * 1_000_000_000)
}

func machineConnectionDecode<T: Decodable>(_ payload: Any, as type: T.Type) -> T? {
  guard JSONSerialization.isValidJSONObject(payload),
        let data = try? JSONSerialization.data(withJSONObject: payload)
  else { return nil }
  return try? JSONDecoder().decode(type, from: data)
}

/// The string without surrounding whitespace, or nil when nothing is left.
func nonEmptyTrimmed(_ value: String?) -> String? {
  guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
  return trimmed
}
