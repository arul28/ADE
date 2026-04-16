import SwiftUI
import UIKit
import AVKit

extension WorkSessionDestinationView {
  @MainActor
  func sendMessage(_ text: String) async -> Bool {
    guard !sending else { return false }
    let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return false }

    localEchoMessages.append(WorkLocalEchoMessage(text: text, timestamp: workDateFormatter.string(from: Date())))
    sending = true
    defer { sending = false }
    do {
      try await syncService.sendChatMessage(sessionId: sessionId, text: text)
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
      return true
    } catch {
      ADEHaptics.error()
      localEchoMessages.removeAll { echo in
        echo.text.trimmingCharacters(in: .whitespacesAndNewlines) == text
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
  func disposeSession() async {
    do {
      try await syncService.disposeChatSession(sessionId: sessionId)
      await load()
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func resumeSession() async {
    do {
      _ = try await syncService.resumeChatSession(sessionId: sessionId)
      await load()
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
  func selectRuntimeMode(_ modeId: String) async {
    guard let summary = chatSummary else { return }
    // Mirror the per-provider flag mapping from the retired session settings
    // sheet so access-pill menu picks land with the same sync payload shape.
    var permissionMode: String?
    var interactionMode: String?
    var claudePermissionMode: String?
    var codexApprovalPolicy: String?
    var codexSandbox: String?
    var codexConfigSource: String?
    var opencodePermissionMode: String?

    switch summary.provider.lowercased() {
    case "claude":
      switch modeId {
      case "plan":
        interactionMode = "plan"
        claudePermissionMode = "default"
        permissionMode = "plan"
      case "edit":
        interactionMode = "default"
        claudePermissionMode = "acceptEdits"
        permissionMode = "edit"
      case "full-auto":
        interactionMode = "default"
        claudePermissionMode = "bypassPermissions"
        permissionMode = "full-auto"
      default:
        interactionMode = "default"
        claudePermissionMode = "default"
        permissionMode = "default"
      }
    case "codex":
      codexConfigSource = "flags"
      switch modeId {
      case "plan":
        codexApprovalPolicy = "untrusted"
        codexSandbox = "read-only"
        permissionMode = "plan"
      case "edit":
        codexApprovalPolicy = "on-failure"
        codexSandbox = "workspace-write"
        permissionMode = "edit"
      case "full-auto":
        codexApprovalPolicy = "never"
        codexSandbox = "danger-full-access"
        permissionMode = "full-auto"
      default:
        codexApprovalPolicy = "on-request"
        codexSandbox = "workspace-write"
        permissionMode = "default"
      }
    case "opencode":
      opencodePermissionMode = modeId
      permissionMode = modeId
    default:
      return
    }

    do {
      _ = try await syncService.updateChatSession(
        sessionId: sessionId,
        permissionMode: permissionMode,
        interactionMode: interactionMode,
        claudePermissionMode: claudePermissionMode,
        codexApprovalPolicy: codexApprovalPolicy,
        codexSandbox: codexSandbox,
        codexConfigSource: codexConfigSource,
        opencodePermissionMode: opencodePermissionMode
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
  func respondToQuestion(itemId: String, answer: String?, responseText: String?) async {
    do {
      let answerValue = answer?.trimmingCharacters(in: .whitespacesAndNewlines)
      let responseValue = responseText?.trimmingCharacters(in: .whitespacesAndNewlines)
      try await syncService.respondToChatInput(
        sessionId: sessionId,
        itemId: itemId,
        answers: answerValue.flatMap { $0.isEmpty ? nil : ["response": .string($0)] },
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
        artifactContent[artifact.id] = .error("The host returned an unreadable image preview.")
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
        artifactContent[artifact.id] = .error("The host returned an artifact payload that could not be decoded.")
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
    guard let laneId = session?.laneId ?? initialSession?.laneId else { return }
    syncService.requestedLaneNavigation = LaneNavigationRequest(laneId: laneId)
  }
}
