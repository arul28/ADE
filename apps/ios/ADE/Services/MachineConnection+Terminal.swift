import Foundation

// MARK: - Terminals

/// The project a terminal of this machine lives in, as this machine names it.
struct MachineTerminalScope: Equatable {
  let projectId: String
  let rootPath: String
}

extension MachineConnection: TerminalStreamTransport {
  /// Name the project of a terminal before it opens. Every terminal envelope
  /// for the session carries this scope, so the host never routes it to a
  /// different project.
  func setTerminalScope(sessionId: String, projectId: String, rootPath: String) {
    terminalScopes[sessionId] = MachineTerminalScope(projectId: projectId, rootPath: rootPath)
  }

  /// A light link that can open a terminal now: live, and the host streams
  /// terminals of any open project.
  var canStreamTerminals: Bool { isLive && supportsRosterTerminal }

  func applyTerminalInputAckFeature(enabled: Bool, config: [String: Any]?) {
    terminalStream.applyInputAckFeature(
      enabled: enabled,
      config: config,
      retryWindowWithoutConfig: enabled ? 60_000 : 0
    )
  }

  func resetTerminalTransportState() {
    terminalStream.resetForNewSocket()
    terminalStream.gapRecovery.removeAll()
  }

  /// A new socket: every open terminal resumes after the last byte it has,
  /// then gets its size back.
  func restoreTerminalSubscriptions() {
    guard supportsRosterTerminal else { return }
    let sessionIds = terminalStream.desired.sorted()
    guard !sessionIds.isEmpty, let restoreSocket = socket else { return }
    Task { @MainActor [weak self] in
      for sessionId in sessionIds {
        // Each subscribe awaits. A newer socket runs its own restore.
        guard let self, self.socket === restoreSocket else { return }
        guard self.terminalStream.desired.contains(sessionId) else { continue }
        do {
          try await self.subscribeTerminalStream(
            sessionId: sessionId,
            sinceOffset: self.terminalStream.endOffsets[sessionId]
          )
        } catch {
          // A project closed or a session ended while the link was down.
          self.terminalStream.reportSubscribeFailure(sessionId: sessionId, error: error)
        }
      }
    }
  }

  private func terminalScopeOrThrow(_ sessionId: String) throws -> MachineTerminalScope {
    guard let scope = terminalScopes[sessionId] else {
      throw NSError(domain: "ADE", code: 7, userInfo: [
        NSLocalizedDescriptionKey: "This terminal has no project on that computer.",
      ])
    }
    return scope
  }

  private func terminalPayload(_ scope: MachineTerminalScope, _ fields: [String: Any]) -> [String: Any] {
    var payload = fields
    if !scope.rootPath.isEmpty { payload["projectRootPath"] = scope.rootPath }
    return payload
  }

  @discardableResult
  func sendTerminalEnvelope(type: String, sessionId: String, fields: [String: Any]) -> Bool {
    guard isLive, let scope = terminalScopes[sessionId] else { return false }
    return send(
      type: type,
      requestId: nil,
      payload: terminalPayload(scope, fields),
      projectId: scope.projectId
    )
  }

  func attachTerminalStream(sessionId: String, handler: @escaping (TerminalStreamEvent) -> Void) -> UUID? {
    guard !sessionId.isEmpty else { return nil }
    return terminalStream.handlers.attach(sessionId: sessionId, handler: handler)
  }

  func detachTerminalStream(sessionId: String, token: UUID?) {
    guard !sessionId.isEmpty, let token else { return }
    terminalStream.handlers.detach(sessionId: sessionId, token: token)
  }

  func hasTerminalStream(sessionId: String) -> Bool {
    terminalStream.handlers[sessionId] != nil
  }

  func subscribeTerminalStream(sessionId: String, sinceOffset: Int?) async throws {
    try await refreshTerminalSnapshot(sessionId: sessionId, maxBytes: syncTerminalStreamMaxBytes, sinceOffset: sinceOffset)
  }

  func refreshTerminalSnapshot(sessionId: String, maxBytes: Int, sinceOffset: Int?) async throws {
    guard !sessionId.isEmpty else { return }
    let scope = try terminalScopeOrThrow(sessionId)
    terminalStream.desired.insert(sessionId)
    guard isLive, supportsRosterTerminal else {
      throw NSError(domain: "ADE", code: 14, userInfo: [
        NSLocalizedDescriptionKey: machineConnectionUnreachableMessage,
      ])
    }
    let requestToken = UUID()
    terminalStream.requestTokens[sessionId] = requestToken
    var fields: [String: Any] = [
      "sessionId": sessionId,
      "maxBytes": max(1_024, min(syncTerminalStreamMaxBytes, maxBytes)),
    ]
    if let sinceOffset, sinceOffset >= 0 { fields["sinceOffset"] = sinceOffset }
    do {
      _ = try await request(
        type: "terminal_subscribe",
        payload: terminalPayload(scope, fields),
        projectId: scope.projectId,
        timeoutNanoseconds: SyncRequestTimeout.defaultTimeoutNanoseconds,
        timeoutMessage: "Timed out opening the terminal.",
        accept: { [weak self] raw in
          guard let self else { return }
          if let dict = raw as? [String: Any],
             let error = dict["error"] as? [String: Any] {
            self.terminalStream.refuseSnapshot(sessionId: sessionId, requestToken: requestToken)
            let message = (error["message"] as? String) ?? "That computer could not open this terminal."
            throw NSError(domain: "ADE", code: 7, userInfo: [NSLocalizedDescriptionKey: message])
          }
          guard let snapshot = machineConnectionDecode(raw, as: TerminalSnapshot.self) else {
            throw NSError(domain: "ADE", code: 15, userInfo: [
              NSLocalizedDescriptionKey: "The machine sent an unreadable terminal snapshot.",
            ])
          }
          self.terminalStream.acceptSnapshot(snapshot, sessionId: sessionId, requestToken: requestToken)
        }
      )
    } catch {
      if terminalStream.requestTokens[sessionId] == requestToken {
        terminalStream.requestTokens.removeValue(forKey: sessionId)
      }
      throw error
    }
  }

  func unsubscribeTerminal(sessionId: String) async throws {
    guard terminalStream.desired.contains(sessionId) else { return }
    terminalStream.unsubscribe(sessionId: sessionId)
    terminalStream.endOffsets.removeValue(forKey: sessionId)
    // The scope stays: the screen may open the session again.
  }

  func resumeCliSession(sessionId: String, cols: Int?, rows: Int?) async throws -> StartCliSessionResult {
    let scope = try terminalScopeOrThrow(sessionId)
    var args: [String: Any] = ["sessionId": sessionId]
    if let cols { args["cols"] = cols }
    if let rows { args["rows"] = rows }
    let raw = try await sendCommand(
      action: "work.resumeCliSession",
      args: args,
      projectId: scope.projectId,
      projectRootPath: scope.rootPath.isEmpty ? nil : scope.rootPath
    )
    guard let result = machineConnectionDecode(raw, as: StartCliSessionResult.self) else {
      throw NSError(domain: "ADE", code: 15, userInfo: [
        NSLocalizedDescriptionKey: "The machine sent an unreadable answer.",
      ])
    }
    return result
  }

  func fetchTerminalHistory(sessionId: String, beforeOffset: Int, maxBytes: Int) async throws -> TerminalHistorySlice {
    let scope = try terminalScopeOrThrow(sessionId)
    guard terminalStream.subscribed.contains(sessionId) else {
      throw NSError(domain: "ADE", code: 7, userInfo: [NSLocalizedDescriptionKey: "Terminal stream is not subscribed."])
    }
    let raw = try await request(
      type: "terminal_history",
      payload: terminalPayload(scope, [
        "sessionId": sessionId,
        "beforeOffset": beforeOffset,
        "maxBytes": max(1_024, min(syncTerminalHistoryMaxBytes, maxBytes)),
      ]),
      projectId: scope.projectId,
      timeoutNanoseconds: SyncRequestTimeout.defaultTimeoutNanoseconds,
      timeoutMessage: SyncRequestTimeout.message
    )
    guard let slice = machineConnectionDecode(raw, as: TerminalHistorySlice.self) else {
      throw NSError(domain: "ADE", code: 15, userInfo: [
        NSLocalizedDescriptionKey: "The machine sent an unreadable terminal history page.",
      ])
    }
    return slice
  }

  func canAcceptTerminalInput(sessionId: String) -> Bool {
    terminalStream.desired.contains(sessionId) && terminalStream.hydrated.contains(sessionId)
  }

  func sendTerminalInput(sessionId: String, data: String) -> SyncTerminalInputSubmission {
    terminalStream.submitInput(
      sessionId: sessionId,
      data: data,
      accepting: canAcceptTerminalInput(sessionId: sessionId)
    )
  }

  func sendTerminalResize(sessionId: String, cols: Int, rows: Int) {
    terminalStream.sendResize(sessionId: sessionId, cols: cols, rows: rows)
  }

  // MARK: Terminal frames

  func handleTerminalData(_ payload: Any) {
    guard let dict = payload as? [String: Any],
          let sessionId = dict["sessionId"] as? String,
          let chunk = dict["data"] as? String,
          terminalStream.subscribed.contains(sessionId) else { return }
    let endOffset = (dict["offset"] as? NSNumber)?.intValue
    guard let deliverable = terminalStream.orderedChunk(
      sessionId: sessionId,
      chunk: chunk,
      endOffset: endOffset
    ), !deliverable.isEmpty else { return }
    terminalStream.handlers[sessionId]?(.chunk(text: deliverable, endOffset: endOffset))
  }

  func handleTerminalExit(_ payload: Any) {
    guard let dict = payload as? [String: Any],
          let sessionId = dict["sessionId"] as? String,
          terminalStream.subscribed.contains(sessionId) else { return }
    terminalStream.handlers[sessionId]?(.exit(code: (dict["exitCode"] as? NSNumber)?.intValue))
  }
}
