import SwiftUI
import UIKit
import AVKit

extension WorkSessionDestinationView {
  @MainActor
  func sendMessage(_ text: String) async -> Bool {
    let useSteer = shouldSteerActiveTurn
    guard !sending || useSteer else { return false }
    let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return false }
    guard canSendChatMessages else { return false }

    let initialDeliveryState = (sendWillQueueChatMessage || useSteer) ? "queued" : "sending"
    let echo = WorkLocalEchoMessage(
      text: text,
      timestamp: workDateFormatter.string(from: Date()),
      deliveryState: initialDeliveryState
    )
    let echoId = echo.id
    localEchoMessages.append(echo)
    sending = true
    defer { sending = false }
    do {
      let delivery: SyncChatMessageDelivery
      if useSteer {
        delivery = try await syncService.steerChatSession(sessionId: sessionId, text: text)
      } else {
        do {
          delivery = try await syncService.sendChatMessage(sessionId: sessionId, text: text)
        } catch where workChatErrorIndicatesActiveTurn(error) {
          updateLocalEchoDeliveryState(echoId: echoId, deliveryState: "queued")
          delivery = try await syncService.steerChatSession(sessionId: sessionId, text: text)
        }
      }
      switch delivery {
      case .queued(let steerId):
        updateLocalEchoDeliveryState(echoId: echoId, deliveryState: "queued")
        if let steerId {
          upsertOptimisticPendingSteer(id: steerId, text: text, timestamp: echo.timestamp)
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
  func approveRequest(itemId: String, decision: AgentChatApprovalDecision) async {
    do {
      try await syncService.approveChatSession(sessionId: sessionId, itemId: itemId, decision: decision)
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
      ADEHaptics.light()
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func selectRuntimeMode(_ modeId: String) async {
    guard let summary = chatSummary else { return }
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
    else { return }

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
      ADEHaptics.light()
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
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
      let filtered: [String: AgentChatInputAnswerValue] = answers.reduce(into: [:]) { acc, pair in
        switch pair.value {
        case .string(let raw):
          let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
          if !trimmed.isEmpty { acc[pair.key] = .string(trimmed) }
        case .strings(let values):
          let cleaned = values
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
          if !cleaned.isEmpty { acc[pair.key] = .strings(cleaned) }
        }
      }
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
        switch answer {
        case .string(let raw):
          let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
          return trimmed.isEmpty ? nil : [questionId: .string(trimmed)]
        case .strings(let values):
          let filtered = values
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
          return filtered.isEmpty ? nil : [questionId: .strings(filtered)]
        }
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
      artifactContent[artifact.id] = .image(cachedImage)
      return
    }

    if let directURL = URL(string: artifact.uri), directURL.scheme?.hasPrefix("http") == true {
      if artifact.artifactKind == "video_recording" || (artifact.mimeType?.contains("video") == true) {
        artifactContent[artifact.id] = .remoteURL(directURL)
      } else if let image = try? await ADEImageCache.shared.loadRemoteImage(from: directURL, cacheKey: cacheKey) {
        artifactContent[artifact.id] = .image(image)
      } else {
        artifactContent[artifact.id] = .error("The machine returned an unreadable image preview.")
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
        artifactContent[artifact.id] = .error("The machine returned an artifact payload that could not be decoded.")
        return
      }

      if artifact.artifactKind == "video_recording" || (artifact.mimeType?.contains("video") == true) {
        let url = FileManager.default.temporaryDirectory
          .appendingPathComponent("ade-work-artifact-\(artifact.id)")
          .appendingPathExtension(fileExtension(for: artifact.mimeType, fallback: "mp4"))
        try data.write(to: url, options: .atomic)
        artifactContent[artifact.id] = .video(url)
      } else if let image = UIImage(data: data) {
        ADEImageCache.shared.store(data, for: cacheKey)
        artifactContent[artifact.id] = .image(image)
      } else {
        artifactContent[artifact.id] = .text(blob.content)
      }
    } catch {
      artifactContent[artifact.id] = .error(error.localizedDescription)
    }
  }

  @MainActor
  func openFileReference(_ path: String) async {
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

  /// Resolve the lane's primary cached PR for the header overflow menu. Runs
  /// inside a `.task(id: headerMenuLaneId)`, so SwiftUI cancels and replaces it
  /// whenever the lane changes. We clear any stale PR up front and re-check the
  /// task identity (cancellation + still-current lane) after the await so a
  /// slow lookup for a previous lane can never surface its PR on a new lane.
  @MainActor
  func resolveLaneOpenPr(for laneId: String) async {
    laneOpenPr = nil
    let trimmed = laneId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }

    let resolved: PullRequestListItem?
    do {
      let items = try await syncService.fetchPullRequestListItems(laneId: trimmed)
      // Prefer an open PR over a closed/merged one when a lane has several.
      resolved = items.first { $0.state.lowercased() == "open" } ?? items.first
    } catch {
      resolved = nil
    }

    let stillCurrent = headerMenuLaneId.trimmingCharacters(in: .whitespacesAndNewlines) == trimmed
    guard !Task.isCancelled, stillCurrent else { return }
    laneOpenPr = resolved
  }

  /// Navigate to the resolved lane PR. No-op (rather than crash) if the PR was
  /// cleared between menu render and tap.
  func openLaneOpenPr() {
    guard let pr = laneOpenPr else { return }
    syncService.requestedPrNavigation = PrNavigationRequest(
      prId: pr.id,
      prNumber: pr.githubPrNumber,
      laneId: pr.laneId
    )
  }
}
