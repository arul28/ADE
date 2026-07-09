import SwiftUI
import UIKit
import AVKit

func workFilteredQuestionAnswersForSubmit(
  _ answers: [String: AgentChatInputAnswerValue]
) -> [String: AgentChatInputAnswerValue] {
  answers.reduce(into: [:]) { acc, pair in
    switch pair.value {
    case .string(let raw):
      if !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        acc[pair.key] = .string(raw)
      }
    case .strings(let values):
      let filtered = values.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
      if !filtered.isEmpty { acc[pair.key] = .strings(filtered) }
    }
  }
}

extension WorkSessionDestinationView {
  @MainActor
  func sendMessage(_ text: String, attachments inputAttachments: [WorkChatInputAttachment] = []) async -> Bool {
    let useSteer = shouldSteerActiveTurn
    guard !sending || useSteer else { return false }
    let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return false }
    guard canSendChatMessages else { return false }

    let attachmentRefs: [AgentChatFileRef]
    do {
      attachmentRefs = try await workChatSaveInputAttachments(
        inputAttachments,
        syncService: syncService,
        chatSessionId: sessionId
      )
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
      return false
    }

    let initialDeliveryState = (sendWillQueueChatMessage || useSteer) ? "queued" : "sending"
    let echo = WorkLocalEchoMessage(
      text: text,
      timestamp: workDateFormatter.string(from: Date()),
      deliveryState: initialDeliveryState,
      attachments: attachmentRefs.isEmpty ? nil : attachmentRefs
    )
    let echoId = echo.id
    localEchoMessages.append(echo)
    sending = true
    defer { sending = false }
    do {
      let delivery: SyncChatMessageDelivery
      if useSteer {
        delivery = try await syncService.steerChatSession(
          sessionId: sessionId,
          text: text,
          attachments: attachmentRefs.isEmpty ? nil : attachmentRefs
        )
      } else {
        do {
          delivery = try await syncService.sendChatMessage(
            sessionId: sessionId,
            text: text,
            attachments: attachmentRefs.isEmpty ? nil : attachmentRefs
          )
        } catch where workChatErrorIndicatesActiveTurn(error) {
          updateLocalEchoDeliveryState(echoId: echoId, deliveryState: "queued")
          delivery = try await syncService.steerChatSession(
            sessionId: sessionId,
            text: text,
            attachments: attachmentRefs.isEmpty ? nil : attachmentRefs
          )
        }
      }
      switch delivery {
      case .queued(let steerId):
        updateLocalEchoDeliveryState(echoId: echoId, deliveryState: "queued")
        if let steerId {
          upsertOptimisticPendingSteer(
            id: steerId,
            text: text,
            timestamp: echo.timestamp,
            attachments: attachmentRefs.isEmpty ? nil : attachmentRefs
          )
        }
      case .sent:
        updateLocalEchoDeliveryState(echoId: echoId, deliveryState: nil)
        await refreshChatStateAfterAction(forceRemote: true)
        reconcileLocalEchoMessages()
      }
      errorMessage = nil
      return true
    } catch {
      ADEHaptics.error()
      localEchoMessages.removeAll { echo in
        echo.id == echoId
      }
      errorMessage = error.localizedDescription
      return false
    }
  }

  @MainActor
  func interruptSession() async {
    do {
      try await syncService.interruptChatSession(sessionId: sessionId)
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func approveRequest(itemId: String, decision: AgentChatApprovalDecision, responseText: String? = nil) async {
    do {
      let responseValue = responseText?.trimmingCharacters(in: .whitespacesAndNewlines)
      try await syncService.approveChatSession(
        sessionId: sessionId,
        itemId: itemId,
        decision: decision,
        responseText: responseValue?.isEmpty == true ? nil : responseValue
      )
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func cancelSteer(_ steerId: String) async {
    do {
      try await syncService.cancelChatSteer(sessionId: sessionId, steerId: steerId)
      optimisticPendingSteers.removeAll { $0.id == steerId }
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func editSteer(_ steerId: String, _ text: String) async {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    do {
      try await syncService.editChatSteer(sessionId: sessionId, steerId: steerId, text: trimmed)
      if let index = optimisticPendingSteers.firstIndex(where: { $0.id == steerId }) {
        optimisticPendingSteers[index] = WorkPendingSteerModel(
          id: steerId,
          text: trimmed,
          attachments: optimisticPendingSteers[index].attachments,
          turnId: optimisticPendingSteers[index].turnId,
          timestamp: workDateFormatter.string(from: Date())
        )
      }
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func dispatchSteerInline(_ steerId: String) async {
    do {
      try await syncService.dispatchChatSteer(sessionId: sessionId, steerId: steerId, mode: "inline")
      optimisticPendingSteers.removeAll { $0.id == steerId }
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func dispatchSteerInterrupt(_ steerId: String) async {
    do {
      try await syncService.dispatchChatSteer(sessionId: sessionId, steerId: steerId, mode: "interrupt")
      optimisticPendingSteers.removeAll { $0.id == steerId }
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func selectModel(_ modelId: String) async {
    do {
      _ = try await syncService.updateChatSession(sessionId: sessionId, modelId: modelId)
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
      // Persist as the app-wide "last used" model so the next New Chat opens on
      // it. The inline picker is cross-provider (a Claude chat can pick e.g. a
      // Codex model), so re-derive the provider from the picked model rather
      // than persisting the chat's old provider — otherwise restore would seed a
      // mismatched provider/model pair the New Chat init does not reconcile.
      // When the provider actually changes, the chat's access mode and
      // sub-settings no longer apply, so reset them to the new provider default.
      if let summary = chatSummary {
        let resolvedProvider = workComposerRuntimeProvider(forModelId: modelId, currentProvider: summary.provider)
        let providerChanged = resolvedProvider != summary.provider
        WorkComposerPreferences.save(
          provider: resolvedProvider,
          modelId: modelId,
          runtimeMode: providerChanged
            ? workDefaultRuntimeMode(provider: resolvedProvider)
            : workInitialRuntimeMode(summary),
          reasoningEffort: providerChanged ? "" : (summary.reasoningEffort ?? ""),
          codexFastMode: providerChanged ? false : summary.effectiveFastMode
        )
      }
      ADEHaptics.light()
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func selectReasoningEffort(_ effort: String) async {
    let trimmed = effort.trimmingCharacters(in: .whitespacesAndNewlines)
    do {
      _ = try await syncService.updateChatSession(sessionId: sessionId, reasoningEffort: trimmed)
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
      // Mirror into the app-wide "last used" selection so the next New Chat
      // restores it. Persisting from here (not only from selectModel) covers a
      // combined model+effort inline change, where selectModel ran first with the
      // prior effort and would otherwise leave the stored effort stale.
      if let summary = chatSummary {
        WorkComposerPreferences.save(
          provider: summary.provider,
          modelId: summary.modelId ?? summary.model,
          runtimeMode: workInitialRuntimeMode(summary),
          reasoningEffort: trimmed,
          codexFastMode: summary.effectiveFastMode
        )
      }
      ADEHaptics.light()
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func selectCodexFastMode(_ enabled: Bool) async -> Bool {
    do {
      _ = try await syncService.updateChatSession(sessionId: sessionId, codexFastMode: enabled)
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
      // Mirror the fast-mode change into the app-wide "last used" selection (the
      // model / effort are unchanged by a fast-mode toggle) so a combined inline
      // change persists the final fast-mode value rather than selectModel's stale one.
      if let summary = chatSummary {
        WorkComposerPreferences.save(
          provider: summary.provider,
          modelId: summary.modelId ?? summary.model,
          runtimeMode: workInitialRuntimeMode(summary),
          reasoningEffort: summary.reasoningEffort ?? "",
          codexFastMode: enabled
        )
      }
      ADEHaptics.light()
      return true
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
      return false
    }
  }

  @MainActor
  func selectRuntimeMode(_ modeId: String) async -> Bool {
    guard let summary = chatSummary else { return false }
    let wire = workRuntimeWireFields(provider: summary.provider, mode: modeId)
    guard wire.permissionMode != nil
      || wire.interactionMode != nil
      || wire.claudePermissionMode != nil
      || wire.codexApprovalPolicy != nil
      || wire.codexSandbox != nil
      || wire.codexConfigSource != nil
      || wire.opencodePermissionMode != nil
      || wire.droidPermissionMode != nil
      || wire.cursorModeId != nil
    else { return false }

    do {
      _ = try await syncService.updateChatSession(
        sessionId: sessionId,
        permissionMode: wire.permissionMode,
        interactionMode: wire.interactionMode,
        claudePermissionMode: wire.claudePermissionMode,
        codexApprovalPolicy: wire.codexApprovalPolicy,
        codexSandbox: wire.codexSandbox,
        codexConfigSource: wire.codexConfigSource,
        opencodePermissionMode: wire.opencodePermissionMode,
        droidPermissionMode: wire.droidPermissionMode,
        cursorModeId: wire.cursorModeId
      )
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
      // Persist as the app-wide "last used" access mode so the next New Chat
      // opens on it (the model / sub-settings are unchanged by a mode change).
      WorkComposerPreferences.save(
        provider: summary.provider,
        modelId: summary.modelId ?? summary.model,
        runtimeMode: modeId,
        reasoningEffort: summary.reasoningEffort ?? "",
        codexFastMode: summary.effectiveFastMode
      )
      ADEHaptics.light()
      return true
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
      return false
    }
  }

  @MainActor
  func submitQuestionAnswers(
    itemId: String,
    answers: [String: AgentChatInputAnswerValue],
    responseText: String?
  ) async {
    do {
      let responseValue = responseText?.trimmingCharacters(in: .whitespacesAndNewlines)
      let filtered = workFilteredQuestionAnswersForSubmit(answers)
      try await syncService.respondToChatInput(
        sessionId: sessionId,
        itemId: itemId,
        decision: .accept,
        answers: filtered.isEmpty ? nil : filtered,
        responseText: (responseValue?.isEmpty ?? true) ? nil : responseValue
      )
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func respondToQuestion(
    itemId: String,
    questionId: String,
    answer: AgentChatInputAnswerValue?,
    responseText: String?
  ) async {
    do {
      let responseValue = responseText?.trimmingCharacters(in: .whitespacesAndNewlines)
      let answers: [String: AgentChatInputAnswerValue]? = {
        guard let answer else { return nil }
        let filtered = workFilteredQuestionAnswersForSubmit([questionId: answer])
        return filtered.isEmpty ? nil : filtered
      }()
      try await syncService.respondToChatInput(
        sessionId: sessionId,
        itemId: itemId,
        decision: .accept,
        answers: answers,
        responseText: responseValue?.isEmpty == true ? nil : responseValue
      )
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func declineQuestion(itemId: String) async {
    do {
      try await syncService.respondToChatInput(
        sessionId: sessionId,
        itemId: itemId,
        decision: .decline,
        answers: nil,
        responseText: nil
      )
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func respondToPermission(itemId: String, decision: AgentChatApprovalDecision) async {
    do {
      try await syncService.respondToChatInput(
        sessionId: sessionId,
        itemId: itemId,
        decision: decision,
        answers: nil,
        responseText: nil
      )
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func loadArtifactContent(_ artifact: ComputerUseArtifactSummary) async {
    guard artifactContent[artifact.id] == nil else { return }
    guard !artifactContentLoadsInFlight.contains(artifact.id) else { return }
    artifactContentLoadsInFlight.insert(artifact.id)
    defer { artifactContentLoadsInFlight.remove(artifact.id) }

    let cacheKey = "work-artifact::\(artifact.id)::\(artifact.uri)"

    if artifact.artifactKind != "video_recording", let cachedImage = ADEImageCache.shared.cachedImage(for: cacheKey) {
      setArtifactContent(.image(cachedImage), for: artifact.id)
      return
    }

    if let directURL = URL(string: artifact.uri), directURL.scheme?.hasPrefix("http") == true {
      if artifact.artifactKind == "video_recording" || (artifact.mimeType?.contains("video") == true) {
        setArtifactContent(.remoteURL(directURL), for: artifact.id)
      } else if let image = try? await ADEImageCache.shared.loadRemoteImage(from: directURL, cacheKey: cacheKey) {
        setArtifactContent(.image(image), for: artifact.id)
      } else {
        setArtifactContent(.error("The machine returned an unreadable image preview."), for: artifact.id)
      }
      return
    }

    do {
      let blob = try await syncService.readArtifact(artifactId: artifact.id, uri: artifact.uri)
      let data: Data?
      if blob.isBinary {
        data = Data(base64Encoded: blob.content)
      } else {
        data = blob.content.data(using: .utf8)
      }

      guard let data else {
        setArtifactContent(.error("The machine returned an artifact payload that could not be decoded."), for: artifact.id)
        return
      }

      if artifact.artifactKind == "video_recording" || (artifact.mimeType?.contains("video") == true) {
        let url = FileManager.default.temporaryDirectory
          .appendingPathComponent("ade-work-artifact-\(artifact.id)")
          .appendingPathExtension(fileExtension(for: artifact.mimeType, fallback: "mp4"))
        try data.write(to: url, options: .atomic)
        setArtifactContent(.video(url), for: artifact.id)
      } else if let image = UIImage(data: data) {
        ADEImageCache.shared.store(data, for: cacheKey)
        setArtifactContent(.image(image), for: artifact.id)
      } else {
        setArtifactContent(.text(blob.content), for: artifact.id)
      }
    } catch {
      setArtifactContent(.error(error.localizedDescription), for: artifact.id)
    }
  }

  @MainActor
  func openFileReference(_ path: String) async {
    guard !personalChat else {
      errorMessage = "Files are not attached to projectless chats."
      return
    }
    guard let session else { return }

    do {
      let workspaces = try await syncService.listWorkspaces()
      guard let workspace = workFilesWorkspace(for: session.laneId, in: workspaces) else {
        errorMessage = "This lane does not have a matching Files workspace on this phone yet. Refresh Files and try again."
        return
      }

      let relativePath = normalizeWorkFileReference(
        path,
        workspaceRoot: workspace.rootPath,
        requestedCwd: chatSummary?.requestedCwd
      )
      guard !relativePath.isEmpty else {
        errorMessage = "ADE could not resolve that file path into the current workspace."
        return
      }

      syncService.requestedFilesNavigation = FilesNavigationRequest(
        workspaceId: workspace.id,
        laneId: session.laneId,
        relativePath: relativePath
      )
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func openPullRequestReference(_ number: Int) async {
    guard !personalChat else {
      errorMessage = "Pull requests are not attached to projectless chats."
      return
    }
    do {
      let pullRequests = try await syncService.fetchPullRequestListItems()
      let laneScoped = pullRequests.first { $0.githubPrNumber == number && $0.laneId == session?.laneId }
      let target = laneScoped ?? pullRequests.first { $0.githubPrNumber == number }

      guard let target else {
        errorMessage = "PR #\(number) is not cached on this phone yet. Refresh PRs and try again."
        return
      }

      syncService.requestedPrNavigation = PrNavigationRequest(prId: target.id)
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func openSessionLane() {
    guard let currentSession = session ?? initialSession else { return }
    let laneId = resolvedWorkNavigationLaneId(for: currentSession, lanes: lanes)
    syncService.requestedLaneNavigation = LaneNavigationRequest(laneId: laneId)
  }

  @MainActor
  func presentSessionRename() {
    sessionActionRenameText = (chatSummary?.title ?? session?.title ?? initialSession?.title ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    sessionActionRenamePresented = true
  }

  @MainActor
  func submitCurrentSessionRename(_ title: String) async {
    let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedTitle.isEmpty else {
      ADEHaptics.error()
      errorMessage = "Session title cannot be empty."
      return
    }
    do {
      if personalChat {
        _ = try await syncService.updateChatSession(
          sessionId: sessionId,
          title: trimmedTitle,
          manuallyNamed: true
        )
      } else {
        try await syncService.updateSessionMeta(
          sessionId: sessionId,
          title: trimmedTitle,
          manuallyNamed: true
        )
        _ = try? await syncService.updateChatSession(
          sessionId: sessionId,
          title: trimmedTitle,
          manuallyNamed: true
        )
      }
      if var currentSession = session {
        currentSession.title = trimmedTitle
        currentSession.manuallyNamed = true
        session = currentSession
      }
      if var summary = chatSummary {
        summary.title = trimmedTitle
        chatSummary = summary
        syncService.cacheChatSummary(summary)
      }
      sessionActionRenameText = ""
      if personalChat {
        _ = try? await syncService.refreshPersonalChats(includeArchived: true)
      }
      await refreshChatStateAfterAction(forceRemote: false)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func deleteCurrentChatSession() async {
    do {
      try await syncService.deleteChatSession(sessionId: sessionId)
      if personalChat {
        syncService.removePersonalChatFromCache(sessionId: sessionId)
      }
      errorMessage = nil
      dismiss()
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func copyCurrentSessionId() {
    UIPasteboard.general.string = sessionId
    sessionIdCopied = true
    Task { @MainActor in
      try? await Task.sleep(nanoseconds: 1_500_000_000)
      guard !Task.isCancelled else { return }
      sessionIdCopied = false
    }
  }

  @MainActor
  func copyCurrentSessionDeepLink() {
    let laneId = (session ?? initialSession).map {
      resolvedWorkNavigationLaneId(for: $0, lanes: lanes)
    }
    let lane = laneId.flatMap { id in lanes.first(where: { $0.id == id }) }
    UIPasteboard.general.string = workSessionDeepLink(
      sessionId: sessionId,
      laneId: laneId,
      envelope: LaneDeeplinkHelpers.envelope(lane: lane, pullRequest: laneOpenPr)
    )
    sessionDeepLinkCopied = true
    Task { @MainActor in
      try? await Task.sleep(nanoseconds: 1_500_000_000)
      guard !Task.isCancelled else { return }
      sessionDeepLinkCopied = false
    }
  }

  @MainActor
  func toggleCurrentSessionPinned() async {
    guard let current = session ?? initialSession else { return }
    let nextPinned = !current.pinned
    do {
      try await syncService.setSessionPinned(sessionId: sessionId, pinned: nextPinned)
      if var currentSession = session {
        currentSession.pinned = nextPinned
        session = currentSession
      }
      await refreshSessionRowFromLocalStore()
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  /// Resolve the lane's primary cached PR for the header overflow menu. Runs
  /// inside a `.task(id: headerMenuPrLookupKey)`, so SwiftUI cancels and
  /// replaces it whenever the lane or the PR projection changes. Re-resolves
  /// are stale-while-revalidate: the current PR is only cleared up front when
  /// the *lane* changed (so a slow lookup for a previous lane can never surface
  /// its PR on a new lane), never on same-lane projection refreshes — clearing
  /// there collapses the header menu's PR section to the "no PR" branch for a
  /// frame and rebuilds the open liquid-glass menu mid-interaction. Final
  /// assignments are equality-guarded for the same reason.
  @MainActor
  func resolveLaneOpenPr(
    for laneId: String,
    forceGithubRefresh: Bool = false,
    clearBeforeLoad: Bool = true
  ) async {
    let trimmed = laneId.trimmingCharacters(in: .whitespacesAndNewlines)
    let laneChanged = trimmed != lastResolvedPrLaneId
    if clearBeforeLoad, laneChanged {
      laneOpenPr = nil
      lanePrSummary = nil
      lanePrTag = nil
    }
    guard !trimmed.isEmpty else {
      lastResolvedPrLaneId = trimmed
      laneOpenPr = nil
      lanePrSummary = nil
      lanePrTag = nil
      return
    }

    let items = (try? await syncService.fetchPullRequestListItems(laneId: trimmed)) ?? []
    let remoteSummary: PrSummary?
    if hostReachable && syncService.supportsRemoteAction("prs.getForLane") {
      remoteSummary = try? await syncService.fetchPullRequestForLane(laneId: trimmed)
    } else {
      remoteSummary = nil
    }

    if hostReachable {
      await syncService.refreshLaneGithubPrItems(force: forceGithubRefresh)
    }

    let resolution = workChatResolveLanePr(
      lane: lanes.first(where: { $0.id == trimmed }),
      pullRequests: items,
      remoteSummary: remoteSummary,
      githubPrs: syncService.laneGithubPrItems
    )

    let stillCurrent = headerMenuLaneId.trimmingCharacters(in: .whitespacesAndNewlines) == trimmed
    guard !Task.isCancelled, stillCurrent else { return }
    lastResolvedPrLaneId = trimmed
    if lanePrSummary != resolution.summary { lanePrSummary = resolution.summary }
    if lanePrTag != resolution.tag { lanePrTag = resolution.tag }
    if laneOpenPr != resolution.mappedPr { laneOpenPr = resolution.mappedPr }
  }

  /// Navigate to the resolved lane PR. No-op (rather than crash) if the PR was
  /// cleared between menu render and tap.
  func openLaneOpenPr() {
    guard let tag = lanePrTag else { return }
    prDetailsPresented = false
    if let prId = tag.prId ?? laneOpenPr?.id, !prId.isEmpty {
      let laneId = (laneOpenPr?.laneId ?? headerMenuLaneId).trimmingCharacters(in: .whitespacesAndNewlines)
      syncService.requestedPrNavigation = PrNavigationRequest(
        prId: prId,
        prNumber: tag.githubPrNumber,
        laneId: laneId.isEmpty ? nil : laneId
      )
    } else {
      syncService.requestedPrNavigation = PrNavigationRequest(prNumber: tag.githubPrNumber)
    }
  }

  func openLanePrOnGitHub() {
    guard !lanePrGitHubUrlString.isEmpty,
          let url = URL(string: lanePrGitHubUrlString) else { return }
    UIApplication.shared.open(url)
  }

  @MainActor
  func openPrCreationInPrsTab() {
    let laneId = headerMenuLaneId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !laneId.isEmpty else { return }
    prDetailsPresented = false
    createPrPresented = false
    syncService.requestedPrNavigation = PrNavigationRequest(createLaneId: laneId)
  }

  @MainActor
  func presentChatPrDetails() {
    prDetailsPresented = true
    Task { await refreshChatPrDetails(force: true) }
  }

  @MainActor
  func refreshChatPrDetails(force: Bool = false) async {
    guard force || !prDetailsRefreshing else { return }
    prDetailsRefreshing = true
    prDetailsError = nil
    defer { prDetailsRefreshing = false }

    await resolveLaneOpenPr(for: headerMenuLaneId, forceGithubRefresh: force, clearBeforeLoad: false)

    guard let prId = laneOpenPr?.id ?? lanePrSummary?.id else {
      prDetailsSnapshot = nil
      await loadPrCreateCapabilitiesIfNeeded()
      return
    }

    if hostReachable {
      do {
        try await syncService.refreshPullRequestSnapshots(prId: prId)
        let items = (try? await syncService.fetchPullRequestListItems(laneId: headerMenuLaneId)) ?? []
        laneOpenPr = workChatMappedPullRequest(for: lanePrTag, in: items)
      } catch {
        prDetailsError = SyncUserFacingError.message(for: error)
      }
    }

    do {
      prDetailsSnapshot = try await syncService.fetchPullRequestSnapshot(prId: prId)
    } catch {
      prDetailsSnapshot = nil
      prDetailsError = SyncUserFacingError.message(for: error)
    }
  }

  @MainActor
  func copyLanePrLink() {
    let urlString = lanePrGitHubUrlString
    guard !urlString.isEmpty else { return }
    UIPasteboard.general.string = urlString
    prLinkCopied = true
    Task {
      try? await Task.sleep(nanoseconds: 1_500_000_000)
      guard !Task.isCancelled else { return }
      prLinkCopied = false
    }
  }

  @MainActor
  func copySubmittedWorkPromptToPasteboard(_ text: String) {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    UIPasteboard.general.string = trimmed
  }

  func presentCreateLanePr() {
    if prDetailsPresented {
      createPrAfterDetailsDismiss = true
      prDetailsPresented = false
      return
    }
    createPrPresented = true
  }

  @MainActor
  func loadPrCreateCapabilitiesIfNeeded() async {
    guard hostReachable else {
      prCreateCapabilities = nil
      return
    }
    do {
      let snapshot = try await syncService.fetchPrMobileSnapshot()
      guard !Task.isCancelled else { return }
      if prCreateCapabilities != snapshot.createCapabilities {
        prCreateCapabilities = snapshot.createCapabilities
      }
    } catch {
      guard !Task.isCancelled else { return }
      prCreateCapabilities = nil
    }
  }

  @MainActor
  func handleChatCreateSinglePr(
    laneId: String,
    title: String,
    body: String,
    draft: Bool,
    baseBranch: String,
    labels: [String],
    reviewers: [String],
    strategy: String?
  ) async -> Bool {
    guard hostReachable else {
      errorMessage = "Connect to your desktop to create a pull request."
      return false
    }
    do {
      try await syncService.createPullRequest(
        laneId: laneId,
        title: title,
        body: body,
        draft: draft,
        baseBranch: baseBranch,
        labels: labels,
        reviewers: reviewers,
        strategy: strategy
      )
      createPrPresented = false
      try? await syncService.refreshPullRequestSnapshots()
      await syncService.refreshLaneGithubPrItems(force: true)
      await resolveLaneOpenPr(for: headerMenuLaneId, forceGithubRefresh: true)
      if prDetailsPresented {
        await refreshChatPrDetails(force: false)
      }
      await loadPrCreateCapabilitiesIfNeeded()
      return true
    } catch {
      errorMessage = error.localizedDescription
      return false
    }
  }
}

struct WorkChatPrResolution {
  var tag: LanePrTag?
  var mappedPr: PullRequestListItem?
  var summary: PrSummary?
}

func workChatResolveLanePr(
  lane: LaneSummary?,
  pullRequests: [PullRequestListItem],
  remoteSummary: PrSummary?,
  githubPrs: [GitHubPrListItem]
) -> WorkChatPrResolution {
  let tag: LanePrTag?
  if let remoteSummary {
    tag = workChatLanePrTag(from: remoteSummary)
  } else if let lane {
    tag = selectLaneTabPrTag(lane: lane, pullRequests: pullRequests, githubPrs: githubPrs)
  } else if let pr = pullRequests.sorted(by: lanePrTagPrecedes).first {
    tag = workChatLanePrTag(from: pr)
  } else {
    tag = nil
  }
  return WorkChatPrResolution(
    tag: tag,
    mappedPr: workChatMappedPullRequest(for: tag, in: pullRequests),
    summary: remoteSummary
  )
}

func workChatLanePrTag(from pr: PullRequestListItem) -> LanePrTag {
  LanePrTag(
    source: .ade,
    prId: pr.id,
    githubPrNumber: pr.githubPrNumber,
    githubUrl: pr.githubUrl,
    title: pr.title,
    state: pr.state,
    headBranch: pr.headBranch,
    updatedAt: pr.updatedAt
  )
}

func workChatLanePrTag(from pr: PrSummary) -> LanePrTag {
  LanePrTag(
    source: .ade,
    prId: pr.id,
    githubPrNumber: pr.githubPrNumber,
    githubUrl: pr.githubUrl,
    title: pr.title,
    state: pr.state,
    headBranch: pr.headBranch,
    updatedAt: pr.updatedAt
  )
}

func workChatMappedPullRequest(
  for tag: LanePrTag?,
  in pullRequests: [PullRequestListItem]
) -> PullRequestListItem? {
  guard let tag else { return nil }
  if let prId = tag.prId,
     let match = pullRequests.first(where: { $0.id == prId }) {
    return match
  }
  return pullRequests.first { pr in
    pr.githubPrNumber == tag.githubPrNumber || pr.githubUrl == tag.githubUrl
  }
}
