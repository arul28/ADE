import Foundation

/// Session-menu commands added for desktop parity: the Claude session tag,
/// auto-handoff rules, and the cross-machine handoff the source brain
/// orchestrates (`chat.*CrossMachineHandoff`). Each one is the command the
/// desktop menu item reaches; the comments name it.
///
/// Every chat-scoped call routes through `chatCommandScope`, so a chat that
/// lives on another machine (or in another project) is handled by the brain
/// that owns it — the same rule desktop follows with its runtime pin.
extension SyncService {
  // MARK: Capability gates

  /// "Auto handoff…" needs all three rule commands; a host that advertises
  /// only some would let the editor read rules it cannot save or remove.
  var autoHandoffRulesAvailable: Bool {
    ["automations.list", "automations.saveDraft", "automations.deleteRule"]
      .allSatisfy { supportsViewerRemoteAction($0) }
  }

  /// The same three commands, asked of the brain that owns this chat (another
  /// machine's connection, or the focused host for its own and foreign
  /// projects). The rules live — and fire — where the chat lives.
  func autoHandoffRulesAvailable(sessionId: String) -> Bool {
    ["automations.list", "automations.saveDraft", "automations.deleteRule"]
      .allSatisfy { canInvokeChatRemoteAction($0, sessionId: sessionId) }
  }

  func crossMachineHandoffAvailable(sessionId: String) -> Bool {
    supportsChatRemoteAction("chat.getCrossMachineHandoffOptions", sessionId: sessionId)
      && supportsChatRemoteAction("chat.startCrossMachineHandoff", sessionId: sessionId)
  }

  func crossMachineHandoffActionAvailable(_ action: String, sessionId: String) -> Bool {
    supportsChatRemoteAction(action, sessionId: sessionId)
  }

  // MARK: Session tag

  /// Desktop "Set tag…": `chat.updateSession { tag }`. An empty string clears
  /// the tag (the brain maps it to null). Tag writes need a live Claude SDK
  /// runtime, which is why the menu offers it only on a running Claude chat.
  func setChatSessionTag(sessionId: String, tag: String) async throws {
    let action = chatActionName("chat.updateSession", sessionId: sessionId)
    try requireInvokableChatAction("chat.updateSession", sessionId: sessionId)
    let scope = chatCommandScope(for: sessionId)
    _ = try await sendCommand(
      action: action,
      args: ["sessionId": sessionId, "tag": tag.trimmingCharacters(in: .whitespacesAndNewlines)],
      targetProjectId: scope.projectId,
      targetProjectRootPath: scope.rootPath
    )
  }

  /// The machine that owns the chat decides whether an action is available,
  /// not the focused one: a chat on another machine routes its commands there
  /// (`chatCommandScope`), so checking the focused machine's capabilities would
  /// refuse a live, updated owner or offer an action the owner lacks.
  func requireInvokableChatAction(_ projectAction: String, sessionId: String) throws {
    guard let connection = remoteChatConnection(for: sessionId) else {
      try requireInvokableRemoteAction(chatActionName(projectAction, sessionId: sessionId))
      return
    }
    guard connection.isLive, connection.supportsAction(projectAction) else {
      throw NSError(
        domain: "ADE",
        code: 15,
        userInfo: [NSLocalizedDescriptionKey: "This action is not available on the machine this chat runs on. Reconnect to refresh capabilities."]
      )
    }
  }

  // MARK: Auto handoff rules

  /// Rules on the chat's own machine — that is where they fire.
  func listAutomationRules(forSessionId sessionId: String) async throws -> [WorkAutomationRuleSummary] {
    try requireInvokableChatAction("automations.list", sessionId: sessionId)
    let scope = chatCommandScope(for: sessionId)
    return try await sendDecodableCommand(
      action: "automations.list",
      targetProjectId: scope.projectId,
      targetProjectRootPath: scope.rootPath,
      as: [WorkAutomationRuleSummary].self
    )
  }

  func saveAutomationDraft(_ draft: [String: Any], forSessionId sessionId: String) async throws {
    try requireInvokableChatAction("automations.saveDraft", sessionId: sessionId)
    let scope = chatCommandScope(for: sessionId)
    _ = try await sendCommand(
      action: "automations.saveDraft",
      args: ["draft": draft],
      targetProjectId: scope.projectId,
      targetProjectRootPath: scope.rootPath
    )
  }

  /// Deletes one rule. "Not found" counts as done: a one-shot rule can retire
  /// itself, and "Remove auto handoff" must still succeed (desktop
  /// `deleteAutomationRules`).
  func deleteAutomationRule(id: String, forSessionId sessionId: String) async throws {
    try requireInvokableChatAction("automations.deleteRule", sessionId: sessionId)
    let scope = chatCommandScope(for: sessionId)
    // The brain treats an already-removed rule as success, so every error
    // here is real.
    _ = try await sendCommand(
      action: "automations.deleteRule",
      args: ["id": id],
      targetProjectId: scope.projectId,
      targetProjectRootPath: scope.rootPath
    )
  }

  // MARK: Cross-machine handoff

  func crossMachineHandoffOptions(sourceSessionId: String) async throws -> AgentChatCrossMachineHandoffOptions {
    let action = chatActionName("chat.getCrossMachineHandoffOptions", sessionId: sourceSessionId)
    try requireInvokableChatAction("chat.getCrossMachineHandoffOptions", sessionId: sourceSessionId)
    let scope = chatCommandScope(for: sourceSessionId)
    return try await sendDecodableCommand(
      action: action,
      args: ["sourceSessionId": sourceSessionId],
      disconnectOnTimeout: false,
      timeoutNanoseconds: 30_000_000_000,
      targetProjectId: scope.projectId,
      targetProjectRootPath: scope.rootPath,
      as: AgentChatCrossMachineHandoffOptions.self
    )
  }

  /// `chat.startCrossMachineHandoff`. `args` carries the target config the
  /// sheet built (model, effort, permission fields, mode, note, flags); the
  /// source session id is added here.
  @discardableResult
  func startCrossMachineHandoff(
    sourceSessionId: String,
    args: [String: Any]
  ) async throws -> AgentChatCrossMachineHandoffRecord? {
    try await sendCrossMachineHandoffCommand(
      "chat.startCrossMachineHandoff",
      sourceSessionId: sourceSessionId,
      extra: args
    )
  }

  /// Retries a failed or unknown move with the SAME handoff id, so the
  /// destination reconciles it instead of starting a second chat.
  @discardableResult
  func retryCrossMachineHandoff(sourceSessionId: String) async throws -> AgentChatCrossMachineHandoffRecord? {
    try await sendCrossMachineHandoffCommand("chat.retryCrossMachineHandoff", sourceSessionId: sourceSessionId, extra: [:])
  }

  /// "Keep it here": cancels a pending move.
  @discardableResult
  func cancelCrossMachineHandoff(sourceSessionId: String) async throws -> AgentChatCrossMachineHandoffRecord? {
    try await sendCrossMachineHandoffCommand("chat.cancelCrossMachineHandoff", sourceSessionId: sourceSessionId, extra: [:])
  }

  @discardableResult
  func resolveCrossMachineHandoffApproval(
    sourceSessionId: String,
    handoffId: String,
    approve: Bool
  ) async throws -> AgentChatCrossMachineHandoffRecord? {
    try await sendCrossMachineHandoffCommand(
      "chat.resolveCrossMachineHandoffApproval",
      sourceSessionId: sourceSessionId,
      extra: ["handoffId": handoffId, "approve": approve]
    )
  }

  /// Records "send here anyway" on a continued chat (`resumedHere`).
  @discardableResult
  func acknowledgeCrossMachineHandoff(
    sourceSessionId: String,
    handoffId: String
  ) async throws -> AgentChatCrossMachineHandoffRecord? {
    try await sendCrossMachineHandoffCommand(
      "chat.acknowledgeCrossMachineHandoff",
      sourceSessionId: sourceSessionId,
      extra: ["handoffId": handoffId]
    )
  }

  /// Reads `detail.crossMachineHandoffState` off a live
  /// `cross_machine_handoff_state` / `cross_machine_handoff_ended` notice and
  /// folds it into the chat's cached summary (desktop AgentChatPane does the
  /// same with `patchSessionSummary`). A key that is present but null clears
  /// the record; an absent key or an unreadable record changes nothing.
  func applyCrossMachineHandoffNoticeIfNeeded(
    envelope: AgentChatEventEnvelope,
    rawPayload: [String: Any]
  ) {
    applyCrossMachineHandoffNoticeIfNeeded(sessionId: envelope.sessionId, rawPayload: rawPayload)
  }

  /// The same fold for a chat on another machine, whose live events reach the
  /// phone through its own `MachineConnection` rather than the focused host.
  func applyCrossMachineHandoffNoticeIfNeeded(sessionId: String, rawPayload: [String: Any]) {
    guard let event = rawPayload["event"] as? [String: Any],
          event["type"] as? String == "system_notice",
          let status = event["status"] as? String,
          status == "cross_machine_handoff_state" || status == "cross_machine_handoff_ended",
          let detail = event["detail"] as? [String: Any],
          detail.keys.contains("crossMachineHandoffState")
    else { return }
    let raw = detail["crossMachineHandoffState"]
    if raw == nil || raw is NSNull {
      clearCrossMachineHandoffRecord(sessionId: sessionId)
      return
    }
    guard let object = raw as? [String: Any],
          let record = try? decode(object, as: AgentChatCrossMachineHandoffRecord.self),
          !record.handoffId.isEmpty
    else { return }
    foldCrossMachineHandoffRecord(record, sessionId: sessionId)
  }

  /// Folds a record an action answered with (cancel, approve, retry,
  /// acknowledge) into the cached summary, so the card moves on before the
  /// summary refresh lands.
  func applyCrossMachineHandoffActionResult(_ record: AgentChatCrossMachineHandoffRecord?, sessionId: String) {
    guard let record, !record.handoffId.isEmpty else { return }
    foldCrossMachineHandoffRecord(record, sessionId: sessionId)
  }

  /// Folds a cross-machine move record into the cached summary for its chat.
  /// The newer of the cached and incoming record wins, so a late older event
  /// cannot roll the card back. No-op when the chat has no cached summary
  /// (the next summary fetch carries the record).
  func foldCrossMachineHandoffRecord(_ record: AgentChatCrossMachineHandoffRecord, sessionId: String) {
    guard var summary = chatSummaryCache[sessionId] else { return }
    summary.crossMachineHandoff = AgentChatCrossMachineHandoffRecord.pickNewer(
      current: summary.crossMachineHandoff,
      incoming: record
    )
    guard summary != chatSummaryCache[sessionId] else { return }
    cacheChatSummary(summary)
  }

  /// Drops the chat's move record: the brain said `crossMachineHandoffState: null`.
  func clearCrossMachineHandoffRecord(sessionId: String) {
    guard var summary = chatSummaryCache[sessionId], summary.crossMachineHandoff != nil else { return }
    summary.crossMachineHandoff = nil
    cacheChatSummary(summary)
  }

  /// Publish / Update branch from the handoff sheet. Desktop pins these to the
  /// chat's machine (`CrossMachineHandoffModal` runtimePin); so does this.
  func pushGitForChat(sessionId: String, laneId: String) async throws {
    let scope = chatCommandScope(for: sessionId)
    _ = try await sendCommand(
      action: "git.push",
      args: ["laneId": laneId, "forceWithLease": false],
      targetProjectId: scope.projectId,
      targetProjectRootPath: scope.rootPath
    )
  }

  func pullGitForChat(sessionId: String, laneId: String) async throws {
    let scope = chatCommandScope(for: sessionId)
    _ = try await sendCommand(
      action: "git.pull",
      args: ["laneId": laneId],
      targetProjectId: scope.projectId,
      targetProjectRootPath: scope.rootPath
    )
  }

  /// Opens the chat a move landed on. The record names the destination by
  /// account machine key, so this is the same request a deeplink to that
  /// session makes; owner resolution switches machines when it has to.
  func openCrossMachineHandoffDestination(_ record: AgentChatCrossMachineHandoffRecord) {
    // Where the chat continues (a later attempt that failed or was cancelled
    // may carry no target of its own); an `unknown` move opens its own target.
    guard let target = workCrossMachineHandoffOpenTarget(record) else { return }
    let machineKey = target.machineKey.trimmingCharacters(in: .whitespacesAndNewlines)
    requestedWorkSessionNavigation = WorkSessionNavigationRequest(
      sessionId: target.sessionId,
      laneId: target.laneId,
      accountMachineKey: machineKey.isEmpty ? nil : machineKey,
      origin: .external
    )
  }

  private func sendCrossMachineHandoffCommand(
    _ projectAction: String,
    sourceSessionId: String,
    extra: [String: Any]
  ) async throws -> AgentChatCrossMachineHandoffRecord? {
    let action = chatActionName(projectAction, sessionId: sourceSessionId)
    try requireInvokableChatAction(projectAction, sessionId: sourceSessionId)
    let scope = chatCommandScope(for: sourceSessionId)
    var args = extra
    args["sourceSessionId"] = sourceSessionId
    let raw = try await sendCommand(
      action: action,
      args: args,
      disconnectOnTimeout: false,
      timeoutNanoseconds: 30_000_000_000,
      targetProjectId: scope.projectId,
      targetProjectRootPath: scope.rootPath
    )
    guard let record = raw as? [String: Any], record["handoffId"] != nil else { return nil }
    return try? decode(record, as: AgentChatCrossMachineHandoffRecord.self)
  }
}

#if DEBUG
extension SyncService {
  /// Fixture seam (`-adePreviewScreen work-list`): advertise these actions as a
  /// connected host would, queueable so the offline fixture can still "invoke"
  /// them. Never reached outside DEBUG fixture screens.
  func seedRemoteCommandActionsForPreview(_ actions: [String]) {
    applyPreviewRemoteCommandDescriptors(actions.map {
      SyncRemoteCommandDescriptor(
        action: $0,
        policy: SyncRemoteCommandPolicy(viewerAllowed: true, queueable: true)
      )
    })
  }
}
#endif
