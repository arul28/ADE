import Foundation

// MARK: - Chat launches (instant new-lane chats)
//
// One host command reserves the chat's session id and lane id, returns at once,
// and the host then fetches the base, checks out the worktree, applies the
// default lane template, creates the chat and sends the opening message. The
// phone opens the chat the moment the user hits send (the session id is the
// launch id, so there is no placeholder swap) and renders the live snapshot the
// host pushes as `chat_launch_event`. Contract:
// `apps/desktop/src/shared/types/chatLaunch.ts`.
//
// State: host snapshots and the per-launch local state (retry request,
// in-flight start, deferred messages) live in `chatLaunchStore`; only
// `chatLaunchKnownUnsupported`, which is per connected host, stays on the class.

/// A host that predates chat launches answers `chat.startLaunch` with
/// "Unsupported remote command" (or a typed unsupported code).
func syncChatLaunchErrorIsUnsupportedCommand(_ error: Error) -> Bool {
  let nsError = error as NSError
  if let code = nsError.userInfo["ADEErrorCode"] as? String,
     ["unsupported_action", "unknown_action", "unknown_command", "unsupported_command"].contains(code) {
    return true
  }
  return nsError.localizedDescription.localizedCaseInsensitiveContains("unsupported remote command")
}

/// One project a launch lives in, as `chat.listLaunches` is scoped.
struct ChatLaunchProjectScope: Hashable {
  let projectId: String?
  let rootPath: String?
}

/// Projects other than the active one whose launches need a pull refresh.
/// Pushed `chat_launch_event`s only reach peers of the active project, so a
/// launch started from the Hub into another project would otherwise freeze.
/// Only launches the host accepted and that are still moving (running, or a
/// CLI launch awaiting its client) count: a failed launch waits on a user
/// action, a finished one has nothing left to report. Empty when nothing is
/// pending, so callers never refresh for nothing.
func chatLaunchForeignRefreshScopes(
  _ entries: [ChatLaunchEntry],
  isActiveProject: (_ projectId: String?, _ rootPath: String?) -> Bool
) -> [ChatLaunchProjectScope] {
  var seen = Set<String>()
  var scopes: [ChatLaunchProjectScope] = []
  for entry in entries.sorted(by: { $0.launchId < $1.launchId }) {
    guard entry.hostAccepted,
          entry.snapshot.phase == .running || entry.snapshot.phase == .awaitingClient
    else { continue }
    let projectId = chatLaunchNormalizedScope(entry.projectId)
    let rootPath = syncNormalizedProjectRootScope(entry.projectRootPath)
    // No recorded scope means it arrived for the active project.
    guard projectId != nil || rootPath != nil, !isActiveProject(projectId, rootPath) else { continue }
    let key = projectId.map { "id:\($0)" } ?? "root:\(rootPath ?? "")"
    guard seen.insert(key).inserted else { continue }
    scopes.append(ChatLaunchProjectScope(projectId: projectId, rootPath: rootPath))
  }
  return scopes
}

/// Whether a new chat into an auto-created lane should use the host-owned
/// launch instead of the chained lanes.create → chat.create → chat.send flow.
func syncShouldUseChatLaunch(
  hostAdvertisesStartLaunch: Bool,
  knownUnsupported: Bool,
  canSendLiveRequests: Bool
) -> Bool {
  hostAdvertisesStartLaunch && !knownUnsupported && canSendLiveRequests
}

@MainActor
extension SyncService {
  /// True when a new auto-lane chat can go through `chat.startLaunch`. Older
  /// hosts do not advertise it and keep the chained flow unchanged; offline
  /// launches also take the chained flow, which already knows how to queue.
  var canStartChatLaunch: Bool {
    syncShouldUseChatLaunch(
      hostAdvertisesStartLaunch: supportsRemoteAction("chat.startLaunch"),
      knownUnsupported: chatLaunchKnownUnsupported,
      canSendLiveRequests: canSendLiveRequests()
    )
  }

  /// Launches for the active project, newest first.
  func activeProjectChatLaunches() -> [ChatLaunchEntry] {
    chatLaunchStore.entries(
      projectId: activeProjectId,
      projectRootPath: activeProjectRootPath,
      isActiveProject: true
    )
  }

  func chatLaunches(for project: MobileProjectSummary) -> [ChatLaunchEntry] {
    chatLaunchStore.entries(
      projectId: project.id,
      projectRootPath: project.rootPath,
      isActiveProject: isActiveProject(project)
    )
  }

  func chatLaunchEntry(sessionId: String) -> ChatLaunchEntry? {
    chatLaunchStore.entry(sessionId: sessionId)
  }

  // MARK: Start

  /// Starts a launch without waiting for the host: inserts the optimistic
  /// snapshot, returns it so the caller can open the chat immediately, then
  /// stages attachments and sends `chat.startLaunch` in the background. A
  /// failure lands on the snapshot (phase failed + error) for the card's
  /// Retry / Delete.
  @discardableResult
  func beginChatLaunch(
    _ request: ChatLaunchRequest,
    resolveAttachments: @escaping @MainActor () async throws -> [AgentChatFileRef] = { [] }
  ) -> ChatLaunchSnapshot {
    let snapshot = chatLaunchOptimisticSnapshot(request: request)
    let (createArgs, _) = chatSessionCreateArgs(
      laneId: request.laneId,
      provider: request.chat.provider,
      model: request.chat.model,
      reasoningEffort: request.chat.reasoningEffort,
      codexFastMode: request.chat.codexFastMode,
      sessionProfile: nil,
      piProfileId: request.chat.piProfileId,
      piProviderId: request.chat.piProviderId,
      piModelId: request.chat.piModelId,
      permissionMode: request.chat.permissionMode,
      interactionMode: request.chat.interactionMode,
      claudePermissionMode: request.chat.claudePermissionMode,
      codexApprovalPolicy: request.chat.codexApprovalPolicy,
      codexSandbox: request.chat.codexSandbox,
      codexConfigSource: request.chat.codexConfigSource,
      opencodePermissionMode: request.chat.opencodePermissionMode,
      droidPermissionMode: request.chat.droidPermissionMode,
      cursorModeId: request.chat.cursorModeId,
      cursorConfigValues: nil,
      computerUse: nil,
      requestedCwd: nil
    )
    chatLaunchStore.updateLocal(launchId: request.launchId) { state in
      state.request = ChatLaunchLocalRequest(
        request: request,
        createArgs: createArgs,
        resolveAttachments: resolveAttachments,
        resolvedAttachments: nil
      )
      state.cancelledWhileStarting = false
    }
    chatLaunchStore.insertOptimistic(
      snapshot,
      projectId: request.projectId ?? activeProjectId,
      projectRootPath: request.projectRootPath ?? activeProjectRootPath,
      provider: request.chat.provider
    )
    Task { @MainActor [weak self] in
      await self?.sendChatLaunchStart(launchId: request.launchId)
    }
    return snapshot
  }

  private func sendChatLaunchStart(launchId: String) async {
    let state = chatLaunchStore.localState(launchId: launchId)
    guard var local = state.request, !state.startInFlight else { return }
    chatLaunchStore.updateLocal(launchId: launchId) { $0.startInFlight = true }
    defer { chatLaunchStore.updateLocal(launchId: launchId) { $0.startInFlight = false } }
    let scope = chatLaunchScope(launchId: launchId)
    do {
      let attachments: [AgentChatFileRef]
      if let resolved = local.resolvedAttachments {
        attachments = resolved
      } else {
        attachments = try await local.resolveAttachments()
        local.resolvedAttachments = attachments
        chatLaunchStore.updateLocal(launchId: launchId) { $0.request = local }
      }
      if !attachments.isEmpty {
        chatLaunchStore.update(launchId: launchId) { $0.prompt.attachments = attachments }
      }
      guard !chatLaunchStore.localState(launchId: launchId).cancelledWhileStarting else { return }
      let args = chatLaunchCommandArgs(
        request: local.request,
        createArgs: local.createArgs,
        attachments: attachments
      )
      let response = try await performCommandRequest(
        action: "chat.startLaunch",
        args: args,
        disconnectOnTimeout: false,
        targetProjectId: scope.projectId,
        targetProjectRootPath: scope.rootPath
      )
      if let snapshot = decodeChatLaunchSnapshotIfPresent(response) {
        chatLaunchStore.apply(snapshot, projectId: scope.projectId, projectRootPath: scope.rootPath)
      }
      await chatLaunchStartDidReachHost(launchId: launchId)
    } catch {
      await chatLaunchStartDidFail(launchId: launchId, error: error)
    }
  }

  private func chatLaunchStartDidReachHost(launchId: String) async {
    if chatLaunchTakeCancelledWhileStarting(launchId: launchId) {
      // Deleted while the start was on the wire: the host now owns a lane the
      // user already threw away. Delete it there too.
      let scope = chatLaunchScope(launchId: launchId)
      _ = try? await performCommandRequest(
        action: "chat.cancelLaunch",
        args: ["launchId": launchId],
        disconnectOnTimeout: false,
        targetProjectId: scope.projectId,
        targetProjectRootPath: scope.rootPath
      )
      chatLaunchStore.remove(launchId: launchId)
      chatLaunchStore.forgetLocalRequest(launchId: launchId)
      return
    }
    // The host's snapshot may not have arrived as a command result (older
    // result shape); a pushed event marks it accepted too. Mark it here so
    // retry/cancel use the host commands from now on.
    if let entry = chatLaunchStore.entry(launchId: launchId), !entry.hostAccepted {
      chatLaunchStore.apply(entry.snapshot)
    }
    await flushDeferredChatLaunchMessages(launchId: launchId)
  }

  /// Send the messages typed before the host accepted the launch, in order.
  /// Each stays visible until the host answers for it. On the first failure
  /// it and everything typed after it go back to the composer with the error
  /// (sending later ones would reorder the conversation).
  private func flushDeferredChatLaunchMessages(launchId: String) async {
    guard !chatLaunchStore.localState(launchId: launchId).flushing else { return }
    chatLaunchStore.updateLocal(launchId: launchId) { $0.flushing = true }
    defer { chatLaunchStore.updateLocal(launchId: launchId) { $0.flushing = false } }
    while let message = chatLaunchStore.localState(launchId: launchId).deferredMessages.first {
      do {
        try await deliverChatLaunchMessage(launchId: launchId, message: message)
      } catch {
        let unsent = [message] + chatLaunchStore.localState(launchId: launchId).deferredMessages
          .filter { $0.id != message.id }
        chatLaunchStore.updateLocal(launchId: launchId) { $0.deferredMessages = [] }
        chatLaunchStore.recordSendFailure(
          launchId: launchId,
          texts: unsent.map(\.text),
          message: chatLaunchSendFailureMessage(error)
        )
        return
      }
    }
  }

  private func chatLaunchStartDidFail(launchId: String, error: Error) async {
    guard chatLaunchStore.entry(launchId: launchId) != nil else { return }
    if chatLaunchTakeCancelledWhileStarting(launchId: launchId) {
      chatLaunchStore.updateLocal(launchId: launchId) { $0.request = nil }
      return
    }
    if isSyncRequestTimeoutError(error), let recovered = try? await refreshChatLaunch(launchId: launchId) {
      // The start reached the host; only its answer was lost.
      if recovered.launchId == launchId {
        await chatLaunchStartDidReachHost(launchId: launchId)
        return
      }
    }
    let message: String
    if syncChatLaunchErrorIsUnsupportedCommand(error) {
      chatLaunchKnownUnsupported = true
      message = "This machine's ADE can't set up lanes for new chats yet. Delete this and send the message again, or update ADE on the machine."
    } else if isSyncRequestTimeoutError(error) {
      message = "The machine didn't answer. Retry to try again."
    } else {
      message = SyncUserFacingError.message(for: error)
    }
    chatLaunchStore.update(launchId: launchId) { snapshot in
      snapshot.phase = .failed
      snapshot.error = message
      snapshot.updatedAt = chatLaunchTimestampFormatter.string(from: Date())
    }
  }

  // MARK: Actions

  /// Retry a failed launch. A launch the host never saw replays
  /// `chat.startLaunch` (idempotent by launch id); otherwise `chat.retryLaunch`.
  func retryChatLaunch(launchId: String) async throws {
    guard let entry = chatLaunchStore.entry(launchId: launchId) else { return }
    if !entry.hostAccepted {
      guard chatLaunchStore.localState(launchId: launchId).request != nil else {
        throw NSError(domain: "ADE", code: 44, userInfo: [NSLocalizedDescriptionKey: "This launch can't be retried from here. Delete it and send the message again."])
      }
      guard !chatLaunchKnownUnsupported else {
        throw NSError(domain: "ADE", code: 44, userInfo: [NSLocalizedDescriptionKey: "Update ADE on the machine to set up lanes for new chats."])
      }
      chatLaunchStore.update(launchId: launchId) { snapshot in
        snapshot.phase = .running
        snapshot.error = nil
      }
      await sendChatLaunchStart(launchId: launchId)
      return
    }
    try await sendChatLaunchAction("chat.retryLaunch", launchId: launchId)
  }

  /// Start the agent now: skip the remaining template steps, or "Start anyway"
  /// after an environment failure.
  func startChatLaunchNow(launchId: String) async throws {
    try await sendChatLaunchAction("chat.startLaunchNow", launchId: launchId)
  }

  /// Delete the launch: the host removes the lane (local + remote branch,
  /// worktree) and the chat. A launch the host never saw is dropped locally.
  func cancelChatLaunch(launchId: String) async throws {
    guard let entry = chatLaunchStore.entry(launchId: launchId) else { return }
    if !entry.hostAccepted {
      chatLaunchStore.updateLocal(launchId: launchId) { state in
        if state.startInFlight {
          state.cancelledWhileStarting = true
        } else {
          state.request = nil
        }
        state.deferredMessages = []
      }
      chatLaunchStore.remove(launchId: launchId)
      return
    }
    do {
      try await sendChatLaunchAction("chat.cancelLaunch", launchId: launchId)
    } catch {
      // The host refuses once the agent started ("This chat already started —
      // delete its lane from the lane menu instead."), or did not answer.
      // Re-read the launch so the screen shows where it really is, then let
      // the caller show the host's message.
      _ = try? await refreshChatLaunch(launchId: launchId)
      throw error
    }
    // The host answers with the cancelled snapshot (or null once the record is
    // gone). Either way this device is done with it.
    chatLaunchStore.update(launchId: launchId) { $0.phase = .cancelled }
    chatLaunchStore.forgetLocalRequest(launchId: launchId)
  }

  /// A message typed while the lane is still being set up. It shows as a
  /// queued bubble at once and stays shown until the host echoes it. Before
  /// the host has the launch it waits and goes out, in order, once it does.
  /// Throws only when the launch is gone. A send the host refuses puts it and
  /// every later message back in the composer via `recordSendFailure`.
  func queueChatLaunchMessage(
    launchId: String,
    text: String,
    displayText: String? = nil,
    attachments: [AgentChatFileRef] = []
  ) async throws {
    guard let entry = chatLaunchStore.entry(launchId: launchId) else {
      throw NSError(domain: "ADE", code: 44, userInfo: [NSLocalizedDescriptionKey: "This chat's lane setup is gone. Send the message from a new chat."])
    }
    let message = ChatLaunchQueuedMessage(
      id: "\(chatLaunchLocalMessageIdPrefix)\(chatLaunchNewId())",
      text: text,
      displayText: displayText,
      attachments: attachments.isEmpty ? nil : attachments,
      createdAt: chatLaunchTimestampFormatter.string(from: Date())
    )
    // Every send goes through the launch's single, ordered send loop. Before
    // the host has the launch (or while its start is still on the wire) the
    // message waits; the start's completion runs the loop.
    chatLaunchStore.updateLocal(launchId: launchId) { $0.deferredMessages.append(message) }
    let local = chatLaunchStore.localState(launchId: launchId)
    guard entry.hostAccepted, !local.startInFlight else { return }
    await flushDeferredChatLaunchMessages(launchId: launchId)
  }

  /// Send one queued message, keeping it on the launch as in flight until the
  /// host answers; the host's snapshot then carries its own copy.
  private func deliverChatLaunchMessage(launchId: String, message: ChatLaunchQueuedMessage) async throws {
    chatLaunchStore.updateLocal(launchId: launchId) { state in
      state.deferredMessages.removeAll { $0.id == message.id }
      if !state.inFlightMessages.contains(where: { $0.id == message.id }) {
        state.inFlightMessages.append(message)
      }
    }
    defer {
      chatLaunchStore.updateLocal(launchId: launchId) { state in
        state.inFlightMessages.removeAll { $0.id == message.id }
      }
    }
    try await sendChatLaunchQueuedMessage(launchId: launchId, message: message)
  }

  private func sendChatLaunchQueuedMessage(launchId: String, message: ChatLaunchQueuedMessage) async throws {
    var args: [String: Any] = ["launchId": launchId, "text": message.text]
    if let displayText = message.displayText, !displayText.isEmpty {
      args["displayText"] = displayText
    }
    if let attachments = message.attachments, !attachments.isEmpty {
      args["attachments"] = chatAttachmentArgs(attachments)
    }
    let scope = chatLaunchScope(launchId: launchId)
    let response = try await performCommandRequest(
      action: "chat.queueLaunchMessage",
      args: args,
      disconnectOnTimeout: false,
      targetProjectId: scope.projectId,
      targetProjectRootPath: scope.rootPath
    )
    if let snapshot = decodeChatLaunchSnapshotIfPresent(response) {
      chatLaunchStore.apply(snapshot, projectId: scope.projectId, projectRootPath: scope.rootPath)
    }
  }

  /// One-shot `chat.getLaunch`. Returns nil when the host no longer knows the
  /// launch (and drops the local copy of a launch it had accepted).
  @discardableResult
  func refreshChatLaunch(launchId: String) async throws -> ChatLaunchSnapshot? {
    guard supportsRemoteAction("chat.getLaunch") else { return chatLaunchStore.snapshot(launchId: launchId) }
    let scope = chatLaunchScope(launchId: launchId)
    let response = try await performCommandRequest(
      action: "chat.getLaunch",
      args: ["launchId": launchId],
      disconnectOnTimeout: false,
      targetProjectId: scope.projectId,
      targetProjectRootPath: scope.rootPath
    )
    guard let snapshot = decodeChatLaunchSnapshotIfPresent(response) else {
      if chatLaunchStore.entry(launchId: launchId)?.hostAccepted == true {
        chatLaunchStore.remove(launchId: launchId)
      }
      return nil
    }
    chatLaunchStore.apply(snapshot, projectId: scope.projectId, projectRootPath: scope.rootPath)
    return chatLaunchStore.snapshot(launchId: launchId)
  }

  /// Hydrate the active project's launches once per connection (project
  /// switches reconnect, so this also covers them), then pull the other
  /// projects that hold moving launches. After this, pushed
  /// `chat_launch_event`s keep the active project current.
  func hydrateChatLaunchesIfSupported() {
    chatLaunchStore.setActiveProjectHydrated(false)
    guard supportsRemoteAction("chat.listLaunches"), canSendLiveRequests() else {
      // Nothing to wait for: this host has no launches to list.
      chatLaunchStore.setActiveProjectHydrated(!supportsRemoteAction("chat.listLaunches"))
      return
    }
    let projectId = activeProjectId
    let rootPath = activeProjectRootPath
    Task { @MainActor [weak self] in
      guard let self else { return }
      guard let response = try? await self.performCommandRequest(
        action: "chat.listLaunches",
        args: [:],
        disconnectOnTimeout: false
      ) else { return }
      // A project switch during the request would file these under the wrong
      // project; the switch's own connection hydrates the new one.
      guard self.activeProjectId == projectId else { return }
      let snapshots = ((try? self.decode(response, as: [ChatLaunchLossy<ChatLaunchSnapshot>].self)) ?? [])
        .compactMap(\.value)
      self.chatLaunchStore.replaceProject(projectId: projectId, projectRootPath: rootPath, with: snapshots)
      self.chatLaunchStore.setActiveProjectHydrated(true)
      self.flushAcceptedChatLaunchMessages()
      await self.refreshForeignProjectChatLaunches()
    }
  }

  /// Projects other than the active one with launches still setting up.
  func foreignChatLaunchRefreshScopes() -> [ChatLaunchProjectScope] {
    chatLaunchForeignRefreshScopes(Array(chatLaunchStore.entries.values)) { [self] projectId, rootPath in
      isActiveProject(id: projectId ?? "", rootPath: rootPath)
    }
  }

  /// Pull `chat.listLaunches` for each non-active project that holds a moving
  /// launch (pushes only cover the active project). A no-op when none does.
  /// Called on connect, on foreground, and on a bounded tick while the Hub is
  /// on screen.
  func refreshForeignProjectChatLaunches() async {
    let scopes = foreignChatLaunchRefreshScopes()
    guard !scopes.isEmpty, supportsRemoteAction("chat.listLaunches"), canSendLiveRequests() else { return }
    for scope in scopes {
      guard let response = try? await performCommandRequest(
        action: "chat.listLaunches",
        args: [:],
        disconnectOnTimeout: false,
        targetProjectId: scope.projectId,
        targetProjectRootPath: scope.rootPath
      ) else { continue }
      let snapshots = ((try? decode(response, as: [ChatLaunchLossy<ChatLaunchSnapshot>].self)) ?? [])
        .compactMap(\.value)
      chatLaunchStore.replaceProject(projectId: scope.projectId, projectRootPath: scope.rootPath, with: snapshots)
    }
    flushAcceptedChatLaunchMessages()
  }

  /// Send any messages still waiting on launches the host now knows about.
  /// A start that failed or timed out locally can still have reached the host;
  /// its later snapshot (a push or a list) is what reveals that, so every path
  /// that applies host snapshots runs this. The send loop's guard makes a
  /// repeat call harmless.
  func flushAcceptedChatLaunchMessages() {
    for (launchId, entry) in chatLaunchStore.entries where entry.hostAccepted {
      let local = chatLaunchStore.localState(launchId: launchId)
      guard !local.deferredMessages.isEmpty, !local.startInFlight, !local.flushing else { continue }
      Task { await self.flushDeferredChatLaunchMessages(launchId: launchId) }
    }
  }

  func applyChatLaunchEventEnvelope(_ envelope: ChatLaunchEventEnvelope) {
    switch envelope.event {
    case .launchUpdated(let snapshot):
      // The host names the launch's project; older hosts do not, and then the
      // push can only be for the active project.
      let hostScoped = envelope.projectId != nil || envelope.projectRootPath != nil
      chatLaunchStore.apply(
        snapshot,
        projectId: hostScoped ? envelope.projectId : activeProjectId,
        projectRootPath: hostScoped ? envelope.projectRootPath : activeProjectRootPath,
        scopeFromHost: hostScoped
      )
      if isChatLaunchTerminal(snapshot.phase) {
        chatLaunchStore.forgetLocalRequest(
          launchId: snapshot.launchId,
          keepMessages: snapshot.phase == .completed
        )
      }
      flushAcceptedChatLaunchMessages()
    case .launchRemoved(let launchId):
      chatLaunchStore.remove(launchId: launchId)
      chatLaunchStore.forgetLocalRequest(launchId: launchId)
    case nil:
      break
    }
  }

  // MARK: Helpers

  /// Reads and clears the "deleted while starting" mark.
  private func chatLaunchTakeCancelledWhileStarting(launchId: String) -> Bool {
    guard chatLaunchStore.localState(launchId: launchId).cancelledWhileStarting else { return false }
    chatLaunchStore.updateLocal(launchId: launchId) { $0.cancelledWhileStarting = false }
    return true
  }

  private func sendChatLaunchAction(_ action: String, launchId: String) async throws {
    try requireInvokableRemoteAction(action)
    let scope = chatLaunchScope(launchId: launchId)
    let response = try await performCommandRequest(
      action: action,
      args: ["launchId": launchId],
      disconnectOnTimeout: false,
      targetProjectId: scope.projectId,
      targetProjectRootPath: scope.rootPath
    )
    if let snapshot = decodeChatLaunchSnapshotIfPresent(response) {
      chatLaunchStore.apply(snapshot, projectId: scope.projectId, projectRootPath: scope.rootPath)
    }
  }

  /// Project scope for a launch's commands: the project it was started in
  /// (the Hub can launch into a project other than the active one).
  private func chatLaunchScope(launchId: String) -> (projectId: String?, rootPath: String?) {
    let entry = chatLaunchStore.entry(launchId: launchId)
    return (entry?.projectId ?? activeProjectId, entry?.projectRootPath ?? activeProjectRootPath)
  }

  private func chatLaunchSendFailureMessage(_ error: Error) -> String {
    let reason = isSyncRequestTimeoutError(error)
      ? "The machine didn't answer."
      : SyncUserFacingError.message(for: error)
    return "Couldn't send — \(reason)"
  }

  private func decodeChatLaunchSnapshotIfPresent(_ response: Any) -> ChatLaunchSnapshot? {
    guard response is [String: Any] else { return nil }
    return try? decode(response, as: ChatLaunchSnapshot.self)
  }
}
