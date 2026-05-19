import SwiftUI
import UIKit
import AVKit

enum WorkSessionNavigationChrome {
  case pushedDetail
  case embedded
}

func workChatCanSendMessages(
  isLive: Bool,
  hostReachable: Bool,
  chatSendQueueable: Bool
) -> Bool {
  isLive && (hostReachable || chatSendQueueable)
}

func workChatSendWillQueueMessage(
  isLive: Bool,
  hostReachable: Bool,
  chatSendQueueable: Bool
) -> Bool {
  isLive && !hostReachable && chatSendQueueable
}

func workChatLiveObservationKey(sessionId: String, chatEventNotificationRevision: Int) -> String {
  "\(sessionId)-\(chatEventNotificationRevision)"
}

func workChatShouldSteerActiveTurn(
  session: TerminalSessionSummary?,
  summary: AgentChatSessionSummary?
) -> Bool {
  normalizedWorkChatSessionStatus(session: session, summary: summary) == "active"
}

func workChatSupportsManualSteerDispatch(
  session: TerminalSessionSummary?,
  summary: AgentChatSessionSummary?
) -> Bool {
  let provider = summary?.provider ?? workChatProviderFamilyFromToolType(session?.toolType)
  guard let provider else { return false }
  return providerFamilyKey(provider) == "claude"
}

func latestActiveTurnId(from transcript: [WorkChatEnvelope]) -> String? {
  for envelope in sortedWorkChatEnvelopes(transcript).reversed() {
    switch envelope.event {
    case .assistantText(_, let turnId, _),
         .activity(_, _, let turnId),
         .userMessage(_, let turnId, _, _, _):
      if let turnId, !turnId.isEmpty { return turnId }
    case .status(_, _, let turnId):
      if let turnId, !turnId.isEmpty { return turnId }
    default:
      continue
    }
  }
  return nil
}

func transcriptContainsResolvedSteer(_ transcript: [WorkChatEnvelope], steerId: String) -> Bool {
  for envelope in sortedWorkChatEnvelopes(transcript).reversed() {
    switch envelope.event {
    case .userMessage(_, _, let candidate, let deliveryState, _):
      guard candidate == steerId else { continue }
      return deliveryState != "queued"
    case .systemNotice(_, let message, _, _, let candidate):
      guard candidate == steerId else { continue }
      return workSystemNoticeResolvesQueuedSteer(message)
    default:
      continue
    }
  }
  return false
}

func workChatShouldPreferFallbackTranscript(
  fallbackTranscript: [WorkChatEnvelope],
  sessionStatus: String,
  liveTranscript: [WorkChatEnvelope]
) -> Bool {
  !fallbackTranscript.isEmpty
    && sessionStatus != "active"
    && !workTranscriptIndicatesActiveTurn(liveTranscript)
}

func workChatErrorIndicatesActiveTurn(_ error: Error) -> Bool {
  let message = (error as NSError).localizedDescription.lowercased()
  return message.contains("turn already active")
    || message.contains("turn is already active")
    || message.contains("already active")
}

private func workChatProviderFamilyFromToolType(_ toolType: String?) -> String? {
  let raw = toolType?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
  guard !raw.isEmpty else { return nil }
  if raw == "cursor" || raw.hasPrefix("cursor") { return "cursor" }
  if raw.hasPrefix("claude") { return "claude" }
  if raw.hasPrefix("codex") { return "codex" }
  if raw.hasPrefix("opencode") { return "opencode" }
  if raw.hasPrefix("droid") || raw.hasPrefix("factory") { return "droid" }
  return raw
}

struct WorkSessionDestinationView: View {
  @EnvironmentObject var syncService: SyncService

  let sessionId: String
  let initialOpeningPrompt: String?
  let initialSession: TerminalSessionSummary?
  let initialChatSummary: AgentChatSessionSummary?
  let initialTranscript: [WorkChatEnvelope]?
  let transitionNamespace: Namespace.ID?
  let isLive: Bool
  let navigationChrome: WorkSessionNavigationChrome
  var showsLaneActions = true
  var navigationTitleOverride: String?
  /// Lanes forwarded to the chat composer for `@`-mention autocomplete.
  var lanes: [LaneSummary] = []

  @State var session: TerminalSessionSummary?
  @State var chatSummary: AgentChatSessionSummary?
  @State var transcript: [WorkChatEnvelope] = []
  @State var fallbackEntries: [AgentChatTranscriptEntry] = []
  @State var artifacts: [ComputerUseArtifactSummary] = []
  @State var localEchoMessages: [WorkLocalEchoMessage] = []
  @State var optimisticPendingSteers: [WorkPendingSteerModel] = []
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
  @State var lastTranscriptRemoteRefreshAt = Date.distantPast
  @State var lastCanonicalTranscriptRefreshAt = Date.distantPast
  @State var lastArtifactRefreshAt = Date.distantPast
  @State var canonicalTranscriptRefreshInFlight = false
  @State var handledOpeningPromptKey: String?
  @State var stagedOpeningPromptKey: String?

  var sessionDestinationNavigationTitle: String {
    if let navigationTitleOverride {
      return navigationTitleOverride
    }
    return chatSummary?.title ?? session?.title ?? "Session"
  }

  var hostReachable: Bool {
    syncService.connectionState == .connected || syncService.connectionState == .syncing
  }

  /// Live polling/load gates require BOTH the parent's "session is live" flag
  /// AND a reachable host. Using `hostReachable` alone enables chat actions
  /// for sessions the parent considers ended/archived.
  var isLiveAndReachable: Bool {
    isLive && hostReachable
  }

  var canComposeChatMessages: Bool {
    session != nil || initialSession != nil
  }

  var canSendChatMessages: Bool {
    workChatCanSendMessages(
      isLive: isLive,
      hostReachable: hostReachable,
      chatSendQueueable: syncService.isRemoteActionQueueable("chat.send")
    )
  }

  var sendWillQueueChatMessage: Bool {
    workChatSendWillQueueMessage(
      isLive: isLive,
      hostReachable: hostReachable,
      chatSendQueueable: syncService.isRemoteActionQueueable("chat.send")
    )
  }

  var shouldSteerActiveTurn: Bool {
    hostReachable && workChatShouldSteerActiveTurn(session: session, summary: chatSummary)
  }

  var supportsManualSteerDispatch: Bool {
    workChatSupportsManualSteerDispatch(session: session, summary: chatSummary)
  }

  /// Trailing nav-bar control scoped to the session's lane. The visible branch
  /// icon keeps it distinct from in-transcript overflow menus.
  @ViewBuilder
  var sessionHeaderTrailingControls: some View {
    if let session, showsLaneActions {
      Button(action: openSessionLane) {
        Image(systemName: "arrow.triangle.branch")
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(ADEColor.textSecondary)
          .frame(width: 34, height: 34)
          .contentShape(Rectangle())
      }
      .buttonStyle(.glass)
      .accessibilityLabel("Open lane \(session.laneName)")
    } else {
      EmptyView()
    }
  }

  var sessionDestinationZoomTransitionId: String? {
    transitionNamespace == nil ? nil : "work-container-\(sessionId)"
  }

  var body: some View {
    sessionDestinationRoot
      .workSessionNavigationChrome(
        mode: navigationChrome,
        title: sessionDestinationNavigationTitle,
        trailingControls: { sessionHeaderTrailingControls }
      )
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
        await reconcileIdleCanonicalTranscriptIfNeeded()
      }
      .task(id: artifactObservationKey) {
        // Proof rows arrive through CRDT-backed local DB updates, not chat
        // event streams, so observe the synced DB revision directly.
        try? await Task.sleep(nanoseconds: 320_000_000)
        guard !Task.isCancelled else { return }
        // Local sync can tick rapidly while a turn is streaming. Coalesce
        // refreshes here so we do not refetch artifact lists for every
        // unrelated revision burst while the user is reading the chat.
        await refreshArtifacts(force: false)
      }
      .task(id: session?.laneId ?? initialSession?.laneId ?? "") {
        await syncLanePresence()
      }
      .task(id: pollingKey) {
        await pollIfNeeded()
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
          optimisticPendingSteers: optimisticPendingSteers,
          localEchoMessages: localEchoMessages,
          expandedToolCardIds: $expandedToolCardIds,
          artifactContent: $artifactContent,
          fullscreenImage: $fullscreenImage,
          artifactRefreshInFlight: artifactRefreshInFlight,
          artifactRefreshError: artifactRefreshError,
          sending: $sending,
          errorMessage: $errorMessage,
          isLive: isLiveAndReachable,
          canComposeMessages: canComposeChatMessages,
          canSendMessages: canSendChatMessages,
          sendWillQueue: sendWillQueueChatMessage || shouldSteerActiveTurn,
          transitionNamespace: transitionNamespace,
          onOpenLane: showsLaneActions ? openSessionLane : nil,
          onSend: sendMessage,
          onInterrupt: interruptSession,
          onApproveRequest: approveRequest,
          onRespondToQuestion: respondToQuestion,
          onSubmitQuestionAnswers: submitQuestionAnswers,
          onDeclineQuestion: declineQuestion,
          onRespondToPermission: respondToPermission,
          onRetryLoad: load,
          onOpenFile: openFileReference,
          onOpenPr: openPullRequestReference,
          onLoadArtifact: loadArtifactContent,
          onRefreshArtifacts: {
            await refreshArtifacts(force: true)
          },
          onCancelSteer: cancelSteer,
          onEditSteer: editSteer,
          onDispatchSteerInline: supportsManualSteerDispatch ? dispatchSteerInline : nil,
          onDispatchSteerInterrupt: supportsManualSteerDispatch ? dispatchSteerInterrupt : nil,
          onSelectModel: selectModel,
          onSelectRuntimeMode: selectRuntimeMode,
          onSelectEffort: selectReasoningEffort,
          lanes: lanes
        )
      } else {
        WorkTerminalSessionView(
          session: session,
          transitionNamespace: transitionNamespace,
          onOpenLane: showsLaneActions ? openSessionLane : nil
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
    return "\(session?.id ?? sessionId)-\(status)-\(isLiveAndReachable)"
  }

  var liveChatObservationKey: String {
    workChatLiveObservationKey(
      sessionId: sessionId,
      chatEventNotificationRevision: syncService.chatEventNotificationRevision
    )
  }

  var artifactObservationKey: String {
    "\(sessionId)-\(syncService.localStateRevision)"
  }

  var trimmedInitialOpeningPrompt: String {
    initialOpeningPrompt?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  }

  @MainActor
  func syncLanePresence() async {
    guard showsLaneActions else { return }
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
      lastSessionRowRefreshAt = Date()
      if let fetchedSummary = try? await syncService.fetchChatSummary(sessionId: sessionId) {
        chatSummary = fetchedSummary
      }
      if !syncService.prefersReducedSyncLoad {
        await refreshArtifacts(force: true)
      }
      await loadTranscript(forceRemote: isLiveAndReachable, preferLightweight: syncService.prefersReducedSyncLoad)
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func loadTranscript(forceRemote: Bool, preferLightweight: Bool = false) async {
    let status = normalizedWorkChatSessionStatus(session: session ?? initialSession, summary: chatSummary ?? initialChatSummary)

    if forceRemote, let currentSession = session ?? initialSession, isChatSession(currentSession) {
      if status == "active" {
        try? await syncService.subscribeToChatEvents(sessionId: sessionId, requestSnapshot: true)
      } else {
        // Active streaming stays on reduced snapshots for performance, but an
        // idle detail view must reconcile against a full event snapshot. A
        // reduced JSONL tail can start mid-message and render as a broken
        // final transcript until the canonical transcript fetch lands.
        try? await syncService.requestFullChatEventSnapshot(sessionId: sessionId)
      }
    }

    let liveTranscript = makeWorkChatTranscript(from: syncService.chatEventHistory(sessionId: sessionId))
    var fallbackTranscript: [WorkChatEnvelope] = []
    var eventTranscript: [WorkChatEnvelope] = []
    var fetchedFallbackEntries: [AgentChatTranscriptEntry] = []
    // Track whether the fallback fetch genuinely produced data so that a
    // skipped or failed fetch preserves the previous fallbackEntries instead
    // of clobbering them with [], which would erase artifact and tool history
    // in the fallback render path.
    var fetchedFallbackEntriesAvailable = false

    // Reduced-load mode skips heavy transcript fetches during live streaming,
    // but once a session is idle the phone must reconcile with the canonical
    // host transcript. Live event snapshots can be byte-capped tails of a long
    // answer, which are useful while streaming but not enough for final copy
    // or history.
    let shouldFetchFallback = !preferLightweight
      || (liveTranscript.isEmpty && transcript.isEmpty)
      || (!liveTranscript.isEmpty && status != "active")
    let fallbackMaxChars = status == "active" ? 32_000 : 120_000
    if shouldFetchFallback, let response = try? await syncService.fetchChatTranscriptResponse(sessionId: sessionId, maxChars: fallbackMaxChars) {
      fetchedFallbackEntries = response.entries
      fetchedFallbackEntriesAvailable = true
      fallbackTranscript = makeWorkChatTranscript(from: response.entries, sessionId: sessionId)
    }

    if forceRemote && !preferLightweight {
      try? await syncService.subscribeTerminal(sessionId: sessionId)
      let raw = syncService.terminalBuffers[sessionId] ?? ""
      let parsed = parseWorkChatTranscript(raw)
      if !parsed.isEmpty {
        eventTranscript = mergeWorkChatTranscripts(base: eventTranscript, live: parsed)
      }
    }

    if !liveTranscript.isEmpty {
      eventTranscript = mergeWorkChatTranscripts(base: eventTranscript, live: liveTranscript)
    }

    let canonicalEventTranscript: [WorkChatEnvelope]
    if !fallbackTranscript.isEmpty, status != "active" {
      canonicalEventTranscript = eventTranscript.filter { envelope in
        switch envelope.event {
        case .userMessage, .assistantText, .status:
          return false
        default:
          return true
        }
      }
    } else {
      canonicalEventTranscript = eventTranscript
    }

    let mergeBaseTranscript = !fallbackTranscript.isEmpty && status != "active" ? [] : transcript
    let mergedTranscript = preferredWorkTranscript(
      current: mergeBaseTranscript,
      fallback: fallbackTranscript,
      eventTranscript: canonicalEventTranscript
    )
    if !mergedTranscript.isEmpty, mergedTranscript != transcript {
      transcript = mergedTranscript
    }
    if fetchedFallbackEntriesAvailable, fallbackEntries != fetchedFallbackEntries {
      fallbackEntries = fetchedFallbackEntries
    }

    reconcileLocalEchoMessages()
    if forceRemote {
      lastTranscriptRemoteRefreshAt = Date()
    }
  }

  @MainActor
  func refreshChatStateAfterAction(forceRemote: Bool = true) async {
    let preferLightweight = syncService.prefersReducedSyncLoad
    await loadTranscript(forceRemote: forceRemote, preferLightweight: preferLightweight)
    if !preferLightweight {
      await refreshArtifacts(force: true)
    }
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
    let minimumRefreshInterval = syncService.prefersReducedSyncLoad ? 15.0 : 0.8
    guard force || now.timeIntervalSince(lastArtifactRefreshAt) >= minimumRefreshInterval else { return }
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
      let useSteer = shouldSteerActiveTurn
      let nextEcho = WorkLocalEchoMessage(
        text: prompt,
        timestamp: workDateFormatter.string(from: Date()),
        deliveryState: (sendWillQueueChatMessage || useSteer) ? "queued" : "sending"
      )
      localEchoMessages.append(nextEcho)
      echo = nextEcho
    }
    let useSteer = shouldSteerActiveTurn
    updateLocalEchoDeliveryState(echoId: echo.id, deliveryState: (sendWillQueueChatMessage || useSteer) ? "queued" : "sending")
    do {
      let delivery: SyncChatMessageDelivery
      if useSteer {
        delivery = try await syncService.steerChatSession(sessionId: sessionId, text: prompt)
      } else {
        do {
          delivery = try await syncService.sendChatMessage(sessionId: sessionId, text: prompt)
        } catch where workChatErrorIndicatesActiveTurn(error) {
          updateLocalEchoDeliveryState(echoId: echo.id, deliveryState: "queued")
          delivery = try await syncService.steerChatSession(sessionId: sessionId, text: prompt)
        }
      }
      switch delivery {
      case .queued(let steerId):
        updateLocalEchoDeliveryState(echoId: echo.id, deliveryState: "queued")
        if let steerId {
          upsertOptimisticPendingSteer(id: steerId, text: prompt, timestamp: echo.timestamp)
        }
      case .sent:
        updateLocalEchoDeliveryState(echoId: echo.id, deliveryState: nil)
        await refreshChatStateAfterAction(forceRemote: true)
      }
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      localEchoMessages.removeAll { $0.id == echo.id }
      errorMessage = "Opening message did not reach the machine. The chat exists; tap Send to retry. \(error.localizedDescription)"
    }
  }

  @MainActor
  func stageInitialOpeningPromptEchoIfNeeded() {
    let prompt = trimmedInitialOpeningPrompt
    guard !prompt.isEmpty else { return }
    let promptKey = "\(sessionId)|\(prompt)"
    guard stagedOpeningPromptKey != promptKey else { return }
    stagedOpeningPromptKey = promptKey
    let useSteer = shouldSteerActiveTurn
    localEchoMessages.append(WorkLocalEchoMessage(
      text: prompt,
      timestamp: workDateFormatter.string(from: Date()),
      deliveryState: (sendWillQueueChatMessage || useSteer) ? "queued" : "sending"
    ))
  }

  @MainActor
  func syncTranscriptFromLiveEvents() {
    let liveTranscript = makeWorkChatTranscript(from: syncService.chatEventHistory(sessionId: sessionId))
    guard !liveTranscript.isEmpty else { return }
    let fallbackTranscript = makeWorkChatTranscript(from: fallbackEntries, sessionId: sessionId)
    let status = normalizedWorkChatSessionStatus(session: session ?? initialSession, summary: chatSummary ?? initialChatSummary)
    let shouldPreferFallbackTranscript = workChatShouldPreferFallbackTranscript(
      fallbackTranscript: fallbackTranscript,
      sessionStatus: status,
      liveTranscript: liveTranscript
    )
    let canonicalLiveTranscript: [WorkChatEnvelope]
    if shouldPreferFallbackTranscript {
      canonicalLiveTranscript = liveTranscript.filter { envelope in
        switch envelope.event {
        case .userMessage, .assistantText, .status:
          return false
        default:
          return true
        }
      }
    } else {
      canonicalLiveTranscript = liveTranscript
    }
    let mergeBaseTranscript = shouldPreferFallbackTranscript ? [] : transcript
    let mergedTranscript = preferredWorkTranscript(
      current: mergeBaseTranscript,
      fallback: fallbackTranscript,
      eventTranscript: canonicalLiveTranscript
    )
    if mergedTranscript != transcript {
      transcript = mergedTranscript
    }
    reconcileOptimisticPendingSteers(with: mergedTranscript)
    reconcileLocalEchoMessages()
  }

  @MainActor
  func upsertOptimisticPendingSteer(id: String, text: String, timestamp: String) {
    let turnId = latestActiveTurnId(from: transcript)
    let model = WorkPendingSteerModel(id: id, text: text, turnId: turnId, timestamp: timestamp)
    if let index = optimisticPendingSteers.firstIndex(where: { $0.id == id }) {
      optimisticPendingSteers[index] = model
    } else {
      optimisticPendingSteers.append(model)
    }
  }

  @MainActor
  func reconcileOptimisticPendingSteers(with transcript: [WorkChatEnvelope]) {
    guard !optimisticPendingSteers.isEmpty else { return }
    let pendingIds = Set(derivePendingWorkSteers(from: transcript).map(\.id))
    optimisticPendingSteers.removeAll { steer in
      transcriptContainsResolvedSteer(transcript, steerId: steer.id) || pendingIds.contains(steer.id)
    }
  }

  @MainActor
  func reconcileIdleCanonicalTranscriptIfNeeded() async {
    guard !canonicalTranscriptRefreshInFlight else { return }
    guard fallbackEntries.isEmpty else { return }

    let status = normalizedWorkChatSessionStatus(session: session ?? initialSession, summary: chatSummary ?? initialChatSummary)
    guard status != "active" else { return }

    let liveTranscript = makeWorkChatTranscript(from: syncService.chatEventHistory(sessionId: sessionId))
    guard !workTranscriptIndicatesActiveTurn(liveTranscript) else { return }

    let hasLiveOrCachedText = !liveTranscript.isEmpty || !transcript.isEmpty
    guard hasLiveOrCachedText else { return }

    let now = Date()
    guard now.timeIntervalSince(lastCanonicalTranscriptRefreshAt) >= 6 else { return }

    canonicalTranscriptRefreshInFlight = true
    lastCanonicalTranscriptRefreshAt = now
    defer { canonicalTranscriptRefreshInFlight = false }

    await loadTranscript(forceRemote: isLiveAndReachable, preferLightweight: false)
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
  func updateLocalEchoDeliveryState(echoId: String, deliveryState: String?) {
    guard let index = localEchoMessages.firstIndex(where: { $0.id == echoId }) else { return }
    localEchoMessages[index].deliveryState = deliveryState
  }

  @MainActor
  func pollIfNeeded() async {
    guard isLiveAndReachable,
          let session,
          isChatSession(session)
    else { return }
    let initialStatus = normalizedWorkChatSessionStatus(session: session, summary: chatSummary)
    guard initialStatus == "active" || initialStatus == "awaiting-input" else { return }
    while !Task.isCancelled, isLiveAndReachable,
      {
        let status = normalizedWorkChatSessionStatus(session: self.session, summary: self.chatSummary)
        return status == "active" || status == "awaiting-input"
      }() {
      syncTranscriptFromLiveEvents()
      let now = Date()
      if now.timeIntervalSince(lastTranscriptRemoteRefreshAt) >= 8 {
        await loadTranscript(forceRemote: true, preferLightweight: syncService.prefersReducedSyncLoad)
      }
      let sessionRefreshInterval = syncService.prefersReducedSyncLoad ? 10.0 : 5.0
      if now.timeIntervalSince(lastSessionRowRefreshAt) >= sessionRefreshInterval {
        lastSessionRowRefreshAt = now
        if let refreshedSummary = try? await syncService.fetchChatSummary(sessionId: sessionId) {
          chatSummary = refreshedSummary
        }
        if let refreshedSession = try? await syncService.fetchSessions().first(where: { $0.id == sessionId }) {
          self.session = refreshedSession
        }
      }
      let artifactRefreshInterval = syncService.prefersReducedSyncLoad ? 30.0 : 12.0
      if now.timeIntervalSince(lastArtifactRefreshAt) >= artifactRefreshInterval {
        await refreshArtifacts(force: false)
      }
      try? await Task.sleep(nanoseconds: syncService.prefersReducedSyncLoad ? 3_000_000_000 : 1_700_000_000)
    }
  }
}

private struct WorkSessionNavigationChromeModifier<TrailingControls: View>: ViewModifier {
  @Environment(\.dismiss) private var dismiss

  let mode: WorkSessionNavigationChrome
  let title: String
  let trailingControls: () -> TrailingControls

  @ViewBuilder
  func body(content: Content) -> some View {
    switch mode {
    case .pushedDetail:
      content
        .safeAreaInset(edge: .top, spacing: 0) {
          HStack(spacing: 10) {
            Button {
              dismiss()
            } label: {
              Image(systemName: "chevron.left")
                .font(.system(size: 17, weight: .semibold))
                .frame(width: 38, height: 38)
            }
            .buttonStyle(.glass)
            .accessibilityLabel("Back to Work")

            Text(title)
              .font(.headline.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(1)
              .truncationMode(.tail)

            Spacer(minLength: 0)

            trailingControls()
          }
          .padding(.horizontal, 16)
          .padding(.bottom, 8)
          .background {
            ADEColor.pageBackground
              .opacity(0.98)
            .ignoresSafeArea(edges: .top)
            .allowsHitTesting(false)
          }
        }
        .navigationTitle("")
        .toolbar(.hidden, for: .tabBar)
        .toolbar(.hidden, for: .navigationBar)
        .adeRootTabBarHidden()
    case .embedded:
      content
    }
  }
}

private extension View {
  func workSessionNavigationChrome<TrailingControls: View>(
    mode: WorkSessionNavigationChrome,
    title: String,
    @ViewBuilder trailingControls: @escaping () -> TrailingControls
  ) -> some View {
    modifier(
      WorkSessionNavigationChromeModifier(
        mode: mode,
        title: title,
        trailingControls: trailingControls
      )
    )
  }
}
