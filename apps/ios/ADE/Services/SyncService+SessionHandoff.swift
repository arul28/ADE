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
    try requireInvokableRemoteAction(action)
    let scope = chatCommandScope(for: sessionId)
    _ = try await sendCommand(
      action: action,
      args: ["sessionId": sessionId, "tag": tag.trimmingCharacters(in: .whitespacesAndNewlines)],
      targetProjectId: scope.projectId,
      targetProjectRootPath: scope.rootPath
    )
  }

  // MARK: Auto handoff rules

  /// Rules on the chat's own machine — that is where they fire.
  func listAutomationRules(forSessionId sessionId: String) async throws -> [WorkAutomationRuleSummary] {
    try requireInvokableRemoteAction("automations.list")
    let scope = chatCommandScope(for: sessionId)
    return try await sendDecodableCommand(
      action: "automations.list",
      targetProjectId: scope.projectId,
      targetProjectRootPath: scope.rootPath,
      as: [WorkAutomationRuleSummary].self
    )
  }

  func saveAutomationDraft(_ draft: [String: Any], forSessionId sessionId: String) async throws {
    try requireInvokableRemoteAction("automations.saveDraft")
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
    try requireInvokableRemoteAction("automations.deleteRule")
    let scope = chatCommandScope(for: sessionId)
    do {
      _ = try await sendCommand(
        action: "automations.deleteRule",
        args: ["id": id],
        targetProjectId: scope.projectId,
        targetProjectRootPath: scope.rootPath
      )
    } catch {
      if error.localizedDescription.range(of: "not found", options: .caseInsensitive) != nil { return }
      throw error
    }
  }

  // MARK: Cross-machine handoff

  func crossMachineHandoffOptions(sourceSessionId: String) async throws -> AgentChatCrossMachineHandoffOptions {
    let action = chatActionName("chat.getCrossMachineHandoffOptions", sessionId: sourceSessionId)
    try requireInvokableRemoteAction(action)
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
    // Prefer where the chat continues: a later attempt that failed or was
    // cancelled may carry no target of its own.
    let continuation = record.continuation
    guard let targetSessionId = (continuation?.targetSessionId ?? record.targetSessionId)?
      .trimmingCharacters(in: .whitespacesAndNewlines),
          !targetSessionId.isEmpty
    else { return }
    let machineKey = (continuation?.targetMachineKey ?? record.targetMachineKey)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    requestedWorkSessionNavigation = WorkSessionNavigationRequest(
      sessionId: targetSessionId,
      laneId: continuation?.targetLaneId ?? record.targetLaneId,
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
    try requireInvokableRemoteAction(action)
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
