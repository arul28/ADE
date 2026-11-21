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

  // MARK: Lane move ("Move this lane to")

  /// The machine and project a lane move acts on: the lane's own brain for a
  /// live move. A lane of another machine carries that machine in its id
  /// (`fleet|<machineKey>|<laneId>`); a lane of the focused machine is in
  /// the chat's project there. The route is kept for the whole move, so its
  /// start, its reads, its retry and the delete after it all name the same
  /// machine, even when the phone's focus moves meanwhile.
  func laneMoveRoute(laneId: String, viaSessionId: String?) throws -> LaneMoveRoute {
    let via = viaSessionId?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let remote = workParseRemoteLaneId(laneId), remote.machineKey != focusedMachineKey {
      if let via, let chat = routedRemoteMachineChat(via) {
        guard chat.machineKey == remote.machineKey else {
          throw NSError(domain: "ADE", code: 26, userInfo: [NSLocalizedDescriptionKey: "This lane and its chat are on different machines."])
        }
        return LaneMoveRoute(machineKey: chat.machineKey, projectId: chat.projectId, rootPath: nonEmptyTrimmed(chat.rootPath))
      }
      let repo = try requireRemoteLaneRepo(machineKey: remote.machineKey)
      return LaneMoveRoute(machineKey: repo.machineKey, projectId: repo.projectId, rootPath: repo.rootPath)
    }
    if let via {
      if let chat = routedRemoteMachineChat(via) {
        return LaneMoveRoute(machineKey: chat.machineKey, projectId: chat.projectId, rootPath: nonEmptyTrimmed(chat.rootPath))
      }
      let scope = chatCommandScope(for: via)
      if let marked = syncFleetParseMarkedProjectId(scope.projectId) {
        return LaneMoveRoute(machineKey: marked.machineKey, projectId: marked.projectId, rootPath: scope.rootPath)
      }
      if let projectId = scope.projectId {
        return LaneMoveRoute(machineKey: focusedMachineKey, projectId: projectId, rootPath: scope.rootPath)
      }
    }
    guard let projectId = activeProjectId else {
      throw NSError(domain: "ADE", code: 14, userInfo: [NSLocalizedDescriptionKey: "Open this lane's project on a computer first."])
    }
    return LaneMoveRoute(machineKey: focusedMachineKey, projectId: projectId, rootPath: activeProject?.rootPath)
  }

  /// The machine of `route` has `action` and lets the phone call it.
  func laneMoveActionAvailable(_ action: String, route: LaneMoveRoute) -> Bool {
    machineAllowsPhoneAction(action, onMachine: route.machineKey)
  }

  /// Sends one lane-move command to the route's machine and project, never
  /// to another one (`sendMachineCommand` throws when that machine is not
  /// connected rather than falling back to the focused one).
  private func sendLaneMoveCommand(
    _ action: String,
    args: [String: Any],
    route: LaneMoveRoute,
    timeoutNanoseconds: UInt64 = 30_000_000_000
  ) async throws -> Any {
    guard laneMoveActionAvailable(action, route: route) else {
      throw NSError(domain: "ADE", code: 15, userInfo: [
        NSLocalizedDescriptionKey: "That computer needs an ADE update to move a lane from the phone. Update ADE there, then try again."
      ])
    }
    return try await sendMachineCommand(
      action: action,
      args: args,
      projectId: route.projectId,
      projectRootPath: route.rootPath,
      timeoutNanoseconds: timeoutNanoseconds,
      onMachine: route.machineKey
    )
  }

  /// `chat.getCrossMachineHandoffOptions` through one of the lane's chats,
  /// on the lane's brain: the machines it may move to, its blockers and the
  /// work that travels.
  func laneMoveOptions(route: LaneMoveRoute, viaSessionId: String) async throws -> AgentChatCrossMachineHandoffOptions {
    let raw = try await sendLaneMoveCommand(
      "chat.getCrossMachineHandoffOptions",
      args: ["sourceSessionId": viaSessionId],
      route: route
    )
    return try decode(raw, as: AgentChatCrossMachineHandoffOptions.self)
  }

  /// The lane's sessions and chats, read on the lane's own brain
  /// (`lanes.getDetail`), for a move opened from a chat. Nothing is cached.
  func readLaneMoveDetail(route: LaneMoveRoute, laneId: String) async throws -> LaneDetailPayload {
    let plain = workParseRemoteLaneId(laneId)?.laneId ?? laneId
    let raw = try await sendLaneMoveCommand("lanes.getDetail", args: ["laneId": plain], route: route)
    return try decode(raw, as: LaneDetailPayload.self)
  }

  /// A lane move (`chat.startCrossMachineBatchMove`) on the lane's brain: the
  /// lane with its commits and uncommitted work arrives on `machineKey`
  /// first, then each chat and CLI, each after its parent. The person asked,
  /// so no approval waits. `clone` lets a computer without the project clone
  /// it from GitHub first.
  func startLaneMoveBatch(
    route: LaneMoveRoute,
    sessionIds: [String],
    machineKey: String,
    clone: Bool
  ) async throws -> LaneMoveBatchRecord {
    var args: [String: Any] = [
      "machine": machineKey,
      "sessionIds": sessionIds,
      "includeDescendants": true,
      "mode": "fork",
      "includeChanges": true,
      "whenBusy": "wait",
    ]
    if clone { args["clone"] = true }
    let raw = try await sendLaneMoveCommand(
      "chat.startCrossMachineBatchMove",
      args: args,
      route: route,
      timeoutNanoseconds: 60_000_000_000
    )
    return try decode(raw, as: LaneMoveBatchRecord.self)
  }

  /// `chat.getCrossMachineBatchMove` on the lane's brain; nil when it no longer knows the batch.
  func readLaneMoveBatch(route: LaneMoveRoute, batchId: String) async throws -> LaneMoveBatchRecord? {
    let raw = try await sendLaneMoveCommand("chat.getCrossMachineBatchMove", args: ["batchId": batchId], route: route)
    guard raw is [String: Any] else { return nil }
    return try decode(raw, as: LaneMoveBatchRecord.self)
  }

  /// `chat.retryCrossMachineBatchMove`: the same batch id goes on, so
  /// what already arrived is not sent again.
  func retryLaneMoveBatch(route: LaneMoveRoute, batchId: String) async throws -> LaneMoveBatchRecord {
    let raw = try await sendLaneMoveCommand(
      "chat.retryCrossMachineBatchMove",
      args: ["batchId": batchId],
      route: route,
      timeoutNanoseconds: 60_000_000_000
    )
    return try decode(raw, as: LaneMoveBatchRecord.self)
  }

  /// `cloud.previewKeptLaneRestore` on the DESTINATION: what a move from
  /// saved copies brings to that machine's project. `fromComputer` names the
  /// lane's asleep ADE Cloud computer: the preview then says whether its
  /// saved copy is complete. Nothing wakes.
  func previewKeptLaneRestore(route: LaneMoveRoute, laneId: String, fromComputer: String? = nil) async throws -> CloudKeptLaneRestorePreview {
    let raw = try await sendLaneMoveCommand(
      "cloud.previewKeptLaneRestore",
      args: keptLaneRestoreArgs(laneId: laneId, fromComputer: fromComputer),
      route: route
    )
    return try decode(raw, as: CloudKeptLaneRestorePreview.self)
  }

  /// `cloud.restoreKeptLane` on the DESTINATION. It answers at once with a
  /// running record; a second start for the same lane joins the first. With
  /// `fromComputer`, the destination first deletes that asleep computer and
  /// keeps its lane, only while its saved copy is complete.
  func restoreKeptLane(route: LaneMoveRoute, laneId: String, fromComputer: String? = nil) async throws -> CloudKeptLaneRestoreRecord {
    let raw = try await sendLaneMoveCommand(
      "cloud.restoreKeptLane",
      args: keptLaneRestoreArgs(laneId: laneId, fromComputer: fromComputer),
      route: route,
      timeoutNanoseconds: 60_000_000_000
    )
    return try decode(raw, as: CloudKeptLaneRestoreRecord.self)
  }

  private func keptLaneRestoreArgs(laneId: String, fromComputer: String?) -> [String: Any] {
    var args: [String: Any] = ["laneId": laneId]
    if let instanceId = fromComputer.flatMap({ nonEmptyTrimmed($0) }) {
      args["fromComputer"] = ["instanceId": instanceId]
    }
    return args
  }

  /// `cloud.getKeptLaneRestore` on the DESTINATION; nil when it no longer knows the restore.
  func readKeptLaneRestore(route: LaneMoveRoute, restoreId: String) async throws -> CloudKeptLaneRestoreRecord? {
    let raw = try await sendLaneMoveCommand("cloud.getKeptLaneRestore", args: ["restoreId": restoreId], route: route)
    guard raw is [String: Any] else { return nil }
    return try decode(raw, as: CloudKeptLaneRestoreRecord.self)
  }

  /// Where a kept lane can come back: each of the person's computers that has
  /// this project open, the focused one first. ADE Cloud computers are left
  /// out. Each target carries its own route: the restore runs there.
  func keptLaneRestoreTargets() -> [LaneMoveTarget] {
    var focused: LaneMoveTarget?
    var others: [LaneMoveTarget] = []
    var seen = Set<String>()
    func reason(online: Bool, name: String, route: LaneMoveRoute) -> String? {
      if !online { return "\(name) is not on." }
      if !laneMoveActionAvailable("cloud.restoreKeptLane", route: route) {
        return "\(name) needs an ADE update to bring a lane back."
      }
      return nil
    }
    if let projectId = activeProjectId, !isCloudFleetKey(focusedMachineKey) {
      let route = LaneMoveRoute(machineKey: focusedMachineKey, projectId: projectId, rootPath: activeProject?.rootPath)
      let name = focusedMachineDisplayName
      let why = reason(online: connectionState == .connected, name: name, route: route)
      focused = LaneMoveTarget(
        id: focusedMachineKey ?? "focused",
        machineKey: focusedMachineKey ?? "",
        name: name,
        ready: why == nil,
        reason: why,
        hasRepository: true,
        route: route
      )
      seen.insert(focusedMachineKey ?? "focused")
    }
    for repo in remoteReposForActiveProject() where !isCloudFleetKey(repo.machineKey) && seen.insert(repo.machineKey).inserted {
      let route = LaneMoveRoute(machineKey: repo.machineKey, projectId: repo.projectId, rootPath: repo.rootPath)
      let why = reason(online: machineFleet?.isLive(repo.machineKey) == true, name: repo.machineName, route: route)
      others.append(LaneMoveTarget(
        id: repo.machineKey,
        machineKey: repo.machineKey,
        name: repo.machineName,
        ready: why == nil,
        reason: why,
        hasRepository: true,
        route: route
      ))
    }
    // The focused machine stays first; the rest go ready first, then by name.
    let rest = others.sorted {
      $0.ready != $1.ready ? $0.ready : $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
    }
    return (focused.map { [$0] } ?? []) + rest
  }

  /// Approves or denies the entire batch waiting on this caller chat. The
  /// session id selects the remote machine/project; the batch id selects the
  /// approval record on that brain.
  func resolveCrossMachineBatchMoveApproval(
    sourceSessionId: String,
    batchId: String,
    approve: Bool
  ) async throws {
    let projectAction = "chat.resolveCrossMachineBatchMoveApproval"
    let action = chatActionName(projectAction, sessionId: sourceSessionId)
    try requireInvokableChatAction(projectAction, sessionId: sourceSessionId)
    let scope = chatCommandScope(for: sourceSessionId)
    _ = try await sendCommand(
      action: action,
      args: ["batchId": batchId, "approve": approve],
      disconnectOnTimeout: false,
      timeoutNanoseconds: 30_000_000_000,
      targetProjectId: scope.projectId,
      targetProjectRootPath: scope.rootPath
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
    // A live record is newer than the brain's clear: the clear is over.
    endCrossMachineHandoffClear(sessionId: sessionId)
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
    // Marked even when the cache holds no record: the open chat's live
    // summary may still hold one.
    markCrossMachineHandoffCleared(sessionId: sessionId, handoffId: chatSummaryCache[sessionId]?.crossMachineHandoff?.handoffId)
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
