import SwiftUI
import UIKit
import AVKit

struct WorkSessionDestinationView: View {
  @EnvironmentObject var syncService: SyncService

  let sessionId: String
  let initialOpeningPrompt: String?
  let initialSession: TerminalSessionSummary?
  let initialChatSummary: AgentChatSessionSummary?
  let initialTranscript: [WorkChatEnvelope]?
  let transitionNamespace: Namespace.ID?
  let isLive: Bool
  let disconnectedNotice: Bool

  @State var session: TerminalSessionSummary?
  @State var chatSummary: AgentChatSessionSummary?
  @State var transcript: [WorkChatEnvelope] = []
  @State var fallbackEntries: [AgentChatTranscriptEntry] = []
  @State var artifacts: [ComputerUseArtifactSummary] = []
  @State var localEchoMessages: [WorkLocalEchoMessage] = []
  @State var expandedToolCardIds = Set<String>()
  @State var artifactContent: [String: WorkLoadedArtifactContent] = [:]
  @State var artifactContentLoadsInFlight = Set<String>()
  @State var artifactRefreshInFlight = false
  @State var artifactRefreshError: String?
  @State var fullscreenImage: WorkFullscreenImage?
  @State var sending = false
  @State var errorMessage: String?
  @State var announcedLaneId: String?
  @State var lastSessionRowRefreshAt = Date.distantPast
  @State var lastArtifactRefreshAt = Date.distantPast
  @State var handledOpeningPromptKey: String?
  @State var stagedOpeningPromptKey: String?

  var sessionDestinationNavigationTitle: String {
    chatSummary?.title ?? session?.title ?? "Session"
  }

  var sessionDestinationZoomTransitionId: String? {
    transitionNamespace == nil ? nil : "work-container-\(sessionId)"
  }

  var body: some View {
    sessionDestinationRoot
      .navigationTitle(sessionDestinationNavigationTitle)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar(.hidden, for: .tabBar)
      .adeNavigationZoomTransition(id: sessionDestinationZoomTransitionId, in: transitionNamespace)
      .sheet(item: $fullscreenImage) { image in
        WorkFullscreenImageView(image: image)
      }
      .task {
        session = initialSession
        chatSummary = initialChatSummary
        transcript = initialTranscript ?? []
        stageInitialOpeningPromptEchoIfNeeded()
        await load()
        await sendInitialOpeningPromptIfNeeded()
      }
      .task(id: liveChatObservationKey) {
        syncTranscriptFromLiveEvents()
        let now = Date()
        if now.timeIntervalSince(lastSessionRowRefreshAt) >= 1.2 {
          lastSessionRowRefreshAt = now
          if let refreshedSession = try? await syncService.fetchSessions().first(where: { $0.id == sessionId }) {
            session = refreshedSession
          }
        }
      }
      .task(id: session?.laneId ?? initialSession?.laneId ?? "") {
        await syncLanePresence()
      }
      .task(id: pollingKey) {
        await pollIfNeeded()
      }
      .task(id: syncService.localStateRevision) {
        await refreshArtifacts(force: false)
      }
      .onDisappear {
        if let announcedLaneId {
          syncService.releaseLaneOpen(laneId: announcedLaneId)
          self.announcedLaneId = nil
        }
        Task {
          try? await syncService.unsubscribeFromChatEvents(sessionId: sessionId)
        }
      }
  }

  @ViewBuilder
  var sessionDestinationRoot: some View {
    if let session {
      if isChatSession(session) {
        WorkChatSessionView(
          session: session,
          chatSummary: chatSummary,
          transcript: transcript,
          fallbackEntries: fallbackEntries,
          artifacts: artifacts,
          localEchoMessages: localEchoMessages,
          expandedToolCardIds: $expandedToolCardIds,
          artifactContent: $artifactContent,
          fullscreenImage: $fullscreenImage,
          artifactRefreshInFlight: artifactRefreshInFlight,
          artifactRefreshError: artifactRefreshError,
          sending: $sending,
          errorMessage: $errorMessage,
          isLive: isLive,
          disconnectedNotice: disconnectedNotice,
          transitionNamespace: transitionNamespace,
          onOpenLane: openSessionLane,
          onSend: sendMessage,
          onInterrupt: interruptSession,
          onDispose: disposeSession,
          onResume: resumeSession,
          onApproveRequest: approveRequest,
          onRespondToQuestion: respondToQuestion,
          onRetryLoad: load,
          onOpenFile: openFileReference,
          onOpenPr: openPullRequestReference,
          onLoadArtifact: loadArtifactContent,
          onRefreshArtifacts: {
            await refreshArtifacts(force: true)
          },
          onCancelSteer: cancelSteer,
          onEditSteer: editSteer,
          onSelectModel: selectModel,
          onSelectRuntimeMode: selectRuntimeMode
        )
      } else {
        WorkTerminalSessionView(
          session: session,
          disconnectedNotice: disconnectedNotice,
          transitionNamespace: transitionNamespace,
          onOpenLane: openSessionLane
        )
        .environmentObject(syncService)
      }
    } else {
      ADEEmptyStateView(
        symbol: "bubble.left.and.bubble.right",
        title: "Session unavailable",
        message: "This session is no longer cached on the phone. Reconnect and refresh Work to restore it."
      )
      .adeScreenBackground()
    }
  }

  var pollingKey: String {
    let status = normalizedWorkChatSessionStatus(session: session, summary: chatSummary)
    return "\(session?.id ?? sessionId)-\(status)-\(isLive)"
  }

  var liveChatObservationKey: String {
    "\(sessionId)-\(syncService.chatEventNotificationRevision)-\(syncService.chatEventRevision(for: sessionId))"
  }

  var trimmedInitialOpeningPrompt: String {
    initialOpeningPrompt?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  }

  @MainActor
  func syncLanePresence() async {
    guard let laneId = session?.laneId ?? initialSession?.laneId else { return }
    guard announcedLaneId != laneId else { return }
    if let announcedLaneId {
      syncService.releaseLaneOpen(laneId: announcedLaneId)
    }
    announcedLaneId = laneId
    syncService.announceLaneOpen(laneId: laneId)
  }

  @MainActor
  func load() async {
    do {
      if let fetchedSession = try await syncService.fetchSessions().first(where: { $0.id == sessionId }) {
        session = fetchedSession
      }
      if let fetchedSummary = try? await syncService.fetchChatSummary(sessionId: sessionId) {
        chatSummary = fetchedSummary
      }
      if isLive, let currentSession = session ?? initialSession, isChatSession(currentSession) {
        try? await syncService.subscribeToChatEvents(sessionId: sessionId)
      }
      await refreshArtifacts(force: true)
      await loadTranscript(forceRemote: isLive)
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func loadTranscript(forceRemote: Bool) async {
    if forceRemote, let currentSession = session ?? initialSession, isChatSession(currentSession) {
      try? await syncService.subscribeToChatEvents(sessionId: sessionId)
    }

    let liveTranscript = makeWorkChatTranscript(from: syncService.chatEventHistory(sessionId: sessionId))
    var baseTranscript: [WorkChatEnvelope] = []
    var fetchedFallbackEntries: [AgentChatTranscriptEntry] = []

    if let response = try? await syncService.fetchChatTranscriptResponse(sessionId: sessionId) {
      fetchedFallbackEntries = response.entries
      baseTranscript = makeWorkChatTranscript(from: response.entries, sessionId: sessionId)
    }

    if forceRemote {
      try? await syncService.subscribeTerminal(sessionId: sessionId)
      let raw = syncService.terminalBuffers[sessionId] ?? ""
      let parsed = parseWorkChatTranscript(raw)
      if !parsed.isEmpty {
        baseTranscript = mergeWorkChatTranscripts(base: baseTranscript, live: parsed)
      }
    }

    if baseTranscript.isEmpty {
      baseTranscript = transcript
    }

    let mergedTranscript = mergeWorkChatTranscripts(base: baseTranscript, live: liveTranscript)
    if !mergedTranscript.isEmpty, mergedTranscript != transcript {
      transcript = mergedTranscript
    }
    if fallbackEntries != fetchedFallbackEntries {
      fallbackEntries = fetchedFallbackEntries
    }

    reconcileLocalEchoMessages()
  }

  @MainActor
  func refreshChatStateAfterAction(forceRemote: Bool = true) async {
    await loadTranscript(forceRemote: forceRemote)
    await refreshArtifacts(force: true)
    if let refreshedSummary = try? await syncService.fetchChatSummary(sessionId: sessionId) {
      chatSummary = refreshedSummary
    }
    if let refreshedSession = try? await syncService.fetchSessions().first(where: { $0.id == sessionId }) {
      session = refreshedSession
    }
  }

  @MainActor
  func refreshArtifacts(force: Bool) async {
    guard let currentSession = session ?? initialSession,
          isChatSession(currentSession)
    else { return }

    let now = Date()
    guard force || now.timeIntervalSince(lastArtifactRefreshAt) >= 0.8 else { return }
    guard !artifactRefreshInFlight else { return }

    artifactRefreshInFlight = true
    lastArtifactRefreshAt = now
    defer { artifactRefreshInFlight = false }

    do {
      let previousURIs = Dictionary(uniqueKeysWithValues: artifacts.map { ($0.id, $0.uri) })
      let refreshed = try await syncService.fetchComputerUseArtifacts(ownerKind: "chat_session", ownerId: sessionId)
      let validArtifactIds = Set(refreshed.map(\.id))

      artifactContent = artifactContent.filter { validArtifactIds.contains($0.key) }
      artifactContentLoadsInFlight = Set(artifactContentLoadsInFlight.filter { validArtifactIds.contains($0) })

      for artifact in refreshed where previousURIs[artifact.id] != nil && previousURIs[artifact.id] != artifact.uri {
        artifactContent.removeValue(forKey: artifact.id)
      }

      if artifacts != refreshed {
        artifacts = refreshed
      }
      artifactRefreshError = nil
    } catch {
      artifactRefreshError = error.localizedDescription
    }
  }

  @MainActor
  func sendInitialOpeningPromptIfNeeded() async {
    let prompt = trimmedInitialOpeningPrompt
    guard !prompt.isEmpty else { return }
    guard !sending else { return }
    let promptKey = "\(sessionId)|\(prompt)"
    guard handledOpeningPromptKey != promptKey else { return }
    if transcript.contains(where: { envelope in
      if case .userMessage(let text, _, _, _, _) = envelope.event {
        return text.trimmingCharacters(in: .whitespacesAndNewlines) == prompt
      }
      return false
    }) {
      handledOpeningPromptKey = promptKey
      return
    }
    handledOpeningPromptKey = promptKey

    let echo: WorkLocalEchoMessage
    if let existingEcho = localEchoMessages.first(where: {
      $0.text.trimmingCharacters(in: .whitespacesAndNewlines) == prompt
    }) {
      echo = existingEcho
    } else {
      let nextEcho = WorkLocalEchoMessage(text: prompt, timestamp: workDateFormatter.string(from: Date()))
      localEchoMessages.append(nextEcho)
      echo = nextEcho
    }
    sending = true
    do {
      try await syncService.sendChatMessage(sessionId: sessionId, text: prompt)
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      localEchoMessages.removeAll { $0.id == echo.id }
      errorMessage = "Opening message did not reach the host. The chat exists; tap Send to retry. \(error.localizedDescription)"
    }
    sending = false
  }

  @MainActor
  func stageInitialOpeningPromptEchoIfNeeded() {
    let prompt = trimmedInitialOpeningPrompt
    guard !prompt.isEmpty else { return }
    let promptKey = "\(sessionId)|\(prompt)"
    guard stagedOpeningPromptKey != promptKey else { return }
    stagedOpeningPromptKey = promptKey
    localEchoMessages.append(WorkLocalEchoMessage(text: prompt, timestamp: workDateFormatter.string(from: Date())))
  }

  @MainActor
  func syncTranscriptFromLiveEvents() {
    let liveTranscript = makeWorkChatTranscript(from: syncService.chatEventHistory(sessionId: sessionId))
    guard !liveTranscript.isEmpty else { return }
    let baseTranscript = transcript.isEmpty && !fallbackEntries.isEmpty
      ? makeWorkChatTranscript(from: fallbackEntries, sessionId: sessionId)
      : transcript
    let mergedTranscript = mergeWorkChatTranscripts(base: baseTranscript, live: liveTranscript)
    if mergedTranscript != transcript {
      transcript = mergedTranscript
    }
    reconcileLocalEchoMessages()
  }

  @MainActor
  func reconcileLocalEchoMessages() {
    guard !localEchoMessages.isEmpty else { return }
    localEchoMessages.removeAll { echo in
      transcript.contains(where: { envelope in
        if case .userMessage(let text, _, _, _, _) = envelope.event {
          return text.trimmingCharacters(in: .whitespacesAndNewlines) == echo.text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return false
      })
    }
  }

  @MainActor
  func pollIfNeeded() async {
    guard isLive,
          let session,
          isChatSession(session)
    else { return }
    let initialStatus = normalizedWorkChatSessionStatus(session: session, summary: chatSummary)
    guard initialStatus == "active" || initialStatus == "awaiting-input" else { return }
    var pollCycle = 0
    while !Task.isCancelled, isLive,
      {
        let status = normalizedWorkChatSessionStatus(session: self.session, summary: self.chatSummary)
        return status == "active" || status == "awaiting-input"
      }() {
      pollCycle += 1
      syncTranscriptFromLiveEvents()
      if pollCycle % 3 == 1 {
        await loadTranscript(forceRemote: true)
      }
      if pollCycle % 2 == 1 {
        await refreshArtifacts(force: false)
        if let refreshedSummary = try? await syncService.fetchChatSummary(sessionId: sessionId) {
          chatSummary = refreshedSummary
        }
        if let refreshedSession = try? await syncService.fetchSessions().first(where: { $0.id == sessionId }) {
          self.session = refreshedSession
        }
      }
      try? await Task.sleep(nanoseconds: 1_700_000_000)
    }
  }
}
