import SwiftUI
import UIKit
import AVKit

enum WorkSessionNavigationChrome {
  case pushedDetail
  case embedded
}

let workSessionEdgeSwipeActivationWidth: CGFloat = 36
let workSessionEdgeSwipeMinimumTranslation: CGFloat = 88
let workSessionEdgeSwipePredictedTranslation: CGFloat = 140

func workSessionShouldDismissForEdgeSwipe(
  startX: CGFloat,
  containerWidth: CGFloat,
  layoutDirection: LayoutDirection,
  translation: CGSize,
  predictedEndTranslation: CGSize
) -> Bool {
  let isRTL = layoutDirection == .rightToLeft
  let leadingEdgeDistance = isRTL ? max(0, containerWidth - startX) : startX
  let horizontalTranslation = isRTL ? -translation.width : translation.width
  let predictedHorizontalTranslation = isRTL ? -predictedEndTranslation.width : predictedEndTranslation.width

  guard leadingEdgeDistance <= workSessionEdgeSwipeActivationWidth else { return false }
  guard horizontalTranslation > 0 else { return false }
  guard abs(translation.height) <= max(48, horizontalTranslation * 0.75) else { return false }
  return horizontalTranslation >= workSessionEdgeSwipeMinimumTranslation
    || predictedHorizontalTranslation >= workSessionEdgeSwipePredictedTranslation
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
         .userMessage(_, _, let turnId, _, _, _):
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
    case .userMessage(_, _, _, let candidate, let deliveryState, _):
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

func workTranscriptEntryIdentity(_ entry: AgentChatTranscriptEntry) -> String {
  [
    entry.timestamp,
    entry.role,
    entry.turnId ?? "",
    entry.text
  ].joined(separator: "\u{1F}")
}

func mergeWorkTranscriptEntries(
  older: [AgentChatTranscriptEntry],
  newer: [AgentChatTranscriptEntry]
) -> [AgentChatTranscriptEntry] {
  var seen = Set<String>()
  var result: [AgentChatTranscriptEntry] = []
  result.reserveCapacity(older.count + newer.count)
  for entry in older + newer {
    if seen.insert(workTranscriptEntryIdentity(entry)).inserted {
      result.append(entry)
    }
  }
  return result
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
  @Environment(\.dismiss) var dismiss

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
  // Canonical transcript entries keyed by their host-side index. Tail
  // refreshes overwrite the newest indices while "load earlier" pages fill
  // older ones, so a poll can never clobber scroll-back history. The cursor
  // is the oldest fetched index (0 = transcript head reached).
  @State var transcriptEntriesByIndex: [Int: AgentChatTranscriptEntry] = [:]
  @State var olderTranscriptCursor: Int?
  @State var olderTranscriptLoading = false
  @State var artifacts: [ComputerUseArtifactSummary] = []
  @State var localEchoMessages: [WorkLocalEchoMessage] = []
  @State var optimisticPendingSteers: [WorkPendingSteerModel] = []
  @State var expandedToolCardIds = Set<String>()
  @State var artifactContent: [String: WorkLoadedArtifactContent] = [:]
  @State var artifactContentLoadsInFlight = Set<String>()
  @State var artifactRefreshInFlight = false
  @State var artifactRefreshError: String?
  @State var fullscreenImage: WorkFullscreenImage?
  @State var artifactDrawerPresented = false
  @State var sending = false
  @State var errorMessage: String?
  @State var announcedLaneId: String?
  /// Lane→PR resolved asynchronously for the header overflow menu's "Open PR"
  /// item. Nil until resolved (or when the lane has no cached PR), which keeps
  /// that menu item disabled with a "No PR yet" hint.
  @State var laneOpenPr: PullRequestListItem?
  @State var prCreateCapabilities: PrCreateCapabilities?
  @State var createPrPresented = false
  @State var prLinkCopied = false
  @State var sessionActionRenamePresented = false
  @State var sessionActionRenameText = ""
  @State var sessionIdCopied = false
  @State var sessionDeepLinkCopied = false
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

  /// Deliberately row-authoritative (does NOT consult `liveTurnActiveHint`):
  /// a stale-true hint must never route a fresh message into the steer queue
  /// of an idle session, where it could sit undispatched. During the window
  /// where the hint is true but the row hasn't flipped yet, `sendMessage`'s
  /// "turn already active" error fallback retries the send as a steer.
  var shouldSteerActiveTurn: Bool {
    hostReachable && workChatShouldSteerActiveTurn(session: session, summary: chatSummary)
  }

  /// Live host-side "turn is running" hint (chat_subscribe ack + status/done
  /// events). Fresher than the synced session row, which arrives via the
  /// slower changeset pump.
  var liveTurnActiveHint: Bool {
    syncService.chatTurnActiveHint(sessionId: sessionId) ?? false
  }

  var supportsManualSteerDispatch: Bool {
    workChatSupportsManualSteerDispatch(session: session, summary: chatSummary)
  }

  /// Lane id the header menu acts on. Resolved against the loaded lane list so
  /// the PR lookup and lane navigation share one canonical id; empty when no
  /// session is available yet (menu is then hidden).
  var headerMenuLaneId: String {
    guard let session = session ?? initialSession else { return "" }
    return resolvedWorkNavigationLaneId(for: session, lanes: lanes)
  }

  /// Trailing nav-bar overflow menu for chat sessions: proof drawer plus lane
  /// shortcuts when the session is lane-backed.
  @ViewBuilder
  var sessionHeaderTrailingControls: some View {
    if let session, isChatSession(session) {
      Menu {
        Button {
          artifactDrawerPresented = true
        } label: {
          if artifacts.isEmpty {
            Label("Proof", systemImage: "cube.transparent")
          } else {
            Label("Proof (\(artifacts.count))", systemImage: "cube.transparent")
          }
        }
        .accessibilityHint("Opens the proof drawer")

        if showsLaneActions {
          Divider()

          chatPullRequestMenuItems
        }

        Divider()

        chatSessionDesktopMenuItems(session)
      } label: {
        Image(systemName: "ellipsis")
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(ADEColor.textSecondary)
          .frame(width: 34, height: 34)
          .contentShape(Rectangle())
      }
      .buttonStyle(.glass)
      .accessibilityLabel("Chat actions")
    } else {
      EmptyView()
    }
  }

  @ViewBuilder
  private var chatPullRequestMenuItems: some View {
    if let laneOpenPr {
      Button {
        openLaneOpenPr()
      } label: {
        Label("Open in ADE (#\(laneOpenPr.githubPrNumber))", systemImage: "arrow.triangle.pull")
      }

      Button {
        openLanePrOnGitHub()
      } label: {
        Label("Open on GitHub", systemImage: "link")
      }
      .disabled(laneOpenPr.githubUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

      Button {
        copyLanePrLink()
      } label: {
        if prLinkCopied {
          Label("Copied link", systemImage: "checkmark")
        } else {
          Label("Copy link", systemImage: "doc.on.doc")
        }
      }
      .disabled(laneOpenPr.githubUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    } else {
      Button {
        presentCreateLanePr()
      } label: {
        Label("Create pull request", systemImage: "plus")
      }
      .disabled(!canCreatePullRequestForHeaderLane)

      if let blockedReason = createPullRequestBlockedReason {
        Button {} label: {
          Label(blockedReason, systemImage: "info.circle")
        }
        .disabled(true)
      }
    }

    Button {
      openSessionLane()
    } label: {
      Label("Open lane", systemImage: "arrow.triangle.branch")
    }
  }

  @ViewBuilder
  private func chatSessionDesktopMenuItems(_ session: TerminalSessionSummary) -> some View {
    Button {
      presentSessionRename()
    } label: {
      Label("Rename", systemImage: "pencil")
    }

    Button(role: .destructive) {
      Task { await deleteCurrentChatSession() }
    } label: {
      Label("Delete chat", systemImage: "trash")
    }

    Button {
      openSessionLane()
    } label: {
      Label("Go to lane", systemImage: "arrow.triangle.branch")
    }
    .disabled(headerMenuLaneId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

    Button {
      copyCurrentSessionId()
    } label: {
      Label(sessionIdCopied ? "Copied session ID" : "Copy session ID",
            systemImage: sessionIdCopied ? "checkmark" : "doc.on.doc")
    }

    Button {
      copyCurrentSessionDeepLink()
    } label: {
      Label(sessionDeepLinkCopied ? "Copied session deep link" : "Copy session deep link",
            systemImage: sessionDeepLinkCopied ? "checkmark" : "link")
    }

    Button {
      Task { await toggleCurrentSessionPinned() }
    } label: {
      Label(session.pinned ? "Unpin from front" : "Pin to front",
            systemImage: session.pinned ? "pin.slash" : "pin")
    }
  }

  private var canCreatePullRequestForHeaderLane: Bool {
    guard hostReachable else { return false }
    let laneId = headerMenuLaneId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !laneId.isEmpty else { return false }
    if let eligibility = prCreateCapabilities?.lanes.first(where: { $0.laneId == laneId }) {
      return eligibility.canCreate
    }
    if let capabilities = prCreateCapabilities {
      return capabilities.canCreateAny
    }
    return !lanes.isEmpty
  }

  private var createPullRequestBlockedReason: String? {
    let laneId = headerMenuLaneId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !laneId.isEmpty else { return nil }
    let reason = prCreateCapabilities?
      .lanes
      .first(where: { $0.laneId == laneId })?
      .blockedReason?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    guard let reason, !reason.isEmpty else { return nil }
    return reason
  }

  @ViewBuilder
  private var chatCreatePrWizardSheet: some View {
    let laneId = headerMenuLaneId.trimmingCharacters(in: .whitespacesAndNewlines)
    CreatePrWizardView(
      lanes: lanes,
      createCapabilities: prCreateCapabilities,
      initialLaneId: laneId.isEmpty ? nil : laneId,
      singleModeOnly: true,
      onCreateSingle: handleChatCreateSinglePr,
      onCreateQueue: { _ in false },
      onCreateIntegration: { _ in false }
    )
    .environmentObject(syncService)
    .presentationDetents([.large])
    .presentationDragIndicator(.visible)
    .presentationContentInteraction(.scrolls)
  }

  var sessionDestinationZoomTransitionId: String? {
    transitionNamespace == nil ? nil : "work-container-\(sessionId)"
  }

  /// Terminal sessions render `TerminalSessionScreen`, which brings its own
  /// slim full-bleed top bar — the shared pushed-detail chrome would stack a
  /// second header on top of it.
  private var isFullScreenTerminalSession: Bool {
    guard let current = session ?? initialSession else { return false }
    return !isChatSession(current)
  }

  var body: some View {
    sessionDestinationRoot
      .workSessionNavigationChrome(
        mode: isFullScreenTerminalSession ? .embedded : navigationChrome,
        title: sessionDestinationNavigationTitle,
        trailingControls: { sessionHeaderTrailingControls }
      )
      .adeNavigationZoomTransition(id: sessionDestinationZoomTransitionId, in: transitionNamespace)
      .sheet(item: $fullscreenImage) { image in
        WorkFullscreenImageView(image: image)
      }
      .sheet(isPresented: $createPrPresented) {
        chatCreatePrWizardSheet
      }
      .alert("Rename session", isPresented: $sessionActionRenamePresented) {
        TextField("Title", text: $sessionActionRenameText)
        Button("Cancel", role: .cancel) {
          sessionActionRenameText = ""
        }
        Button("Save") {
          let title = sessionActionRenameText
          Task { await submitCurrentSessionRename(title) }
        }
      } message: {
        Text("Give this session a clearer title for search, pinning, and activity tracking.")
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
        // Proof rows and the session row both arrive through CRDT-backed
        // local DB updates, not chat event streams, so observe the synced DB
        // revision directly.
        try? await Task.sleep(nanoseconds: 320_000_000)
        guard !Task.isCancelled else { return }
        // The session row is the status source for the stop button and the
        // poll-loop gate. Without this re-read, a turn started on desktop
        // while this view is open in an idle state never updates the local
        // @State row — the chat streams output but renders as frozen
        // (pollIfNeeded bails on non-active status and nothing else
        // observes the DB).
        await refreshSessionRowFromLocalStore()
        // Local sync can tick rapidly while a turn is streaming. Coalesce
        // refreshes here so we do not refetch artifact lists for every
        // unrelated revision burst while the user is reading the chat.
        await refreshArtifacts(force: false)
      }
      .task(id: session?.laneId ?? initialSession?.laneId ?? "") {
        await syncLanePresence()
      }
      .task(id: headerMenuLaneId) {
        await resolveLaneOpenPr(for: headerMenuLaneId)
        await loadPrCreateCapabilitiesIfNeeded()
      }
      .task(id: pollingKey) {
        await pollIfNeeded()
      }
      .onDisappear {
        if let announcedLaneId {
          syncService.releaseLaneOpen(laneId: announcedLaneId)
          self.announcedLaneId = nil
        }
        cleanupLoadedArtifactContent()
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
          artifactDrawerPresented: $artifactDrawerPresented,
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
          onSelectCodexFastMode: selectCodexFastMode,
          lanes: lanes,
          hasOlderTranscriptHistory: hasOlderTranscriptHistory,
          onLoadOlderTranscript: loadOlderTranscriptEntries,
          liveTurnActiveHint: liveTurnActiveHint
        )
      } else {
        TerminalSessionScreen(session: session)
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
    // liveTurnActiveHint participates so a desktop-started turn (session row
    // still idle locally) restarts the poll task the moment the hint flips on.
    return "\(session?.id ?? sessionId)-\(status)-\(isLiveAndReachable)-\(liveTurnActiveHint)"
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
      let alreadySubscribed = syncService.subscribedChatSessionIds.contains(sessionId)
      if status == "active" {
        // First visit subscribes (the host answers with a snapshot or a
        // sinceSeq replay). Once subscribed, live chat_event push plus the
        // host's transcript pump cover continuity — re-requesting a full
        // byte-capped snapshot on every 8s poll was redundant wire traffic
        // and a full dedupe/sort merge on the phone mid-stream.
        try? await syncService.subscribeToChatEvents(sessionId: sessionId, requestSnapshot: !alreadySubscribed)
      } else if !alreadySubscribed {
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
    if shouldFetchFallback, let page = try? await syncService.fetchChatTranscriptPage(sessionId: sessionId, maxChars: fallbackMaxChars) {
      recordTranscriptPage(page, before: nil)
      fetchedFallbackEntries = combinedTranscriptEntries()
      fetchedFallbackEntriesAvailable = true
      fallbackTranscript = makeWorkChatTranscript(from: fetchedFallbackEntries, sessionId: sessionId)
    }

    // Chat-only fallback: parses chat envelopes out of the raw terminal buffer.
    // Terminal sessions own their subscription via TerminalSessionScreen's
    // offset stream; a preview-budget subscribe here would race a second
    // replace-snapshot into that stream.
    if forceRemote && !preferLightweight, let currentSession = session ?? initialSession, isChatSession(currentSession) {
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
        workChatEventIncludedInIdleCanonicalEventTranscript(envelope.event)
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
    reconcileOptimisticPendingSteers(with: mergedTranscript)
    reconcileLocalEchoMessages()
    if forceRemote {
      lastTranscriptRemoteRefreshAt = Date()
    }
  }

  /// Fold one host transcript page into the index-keyed store. `cursor` is
  /// the `before` index the page was requested with (nil for a tail fetch).
  /// Host indices are stable because the transcript is append-only.
  @MainActor
  func recordTranscriptPage(_ page: SyncService.AgentChatTranscriptPage, before cursor: Int?) {
    let end = min(cursor ?? page.totalEntries, page.totalEntries)
    let start = max(0, end - page.entries.count)
    let pageCursor = page.nextCursor ?? 0
    if cursor == nil {
      // Tail refresh. If the new window starts past everything stored (a
      // burst of entries landed between polls), stitching would render a
      // transcript with a silent hole — reset to the fresh tail instead and
      // re-anchor scroll-back below it.
      let nextContiguousIndex = transcriptEntriesByIndex.keys.max().map { $0 + 1 } ?? 0
      if start > nextContiguousIndex, !page.entries.isEmpty {
        transcriptEntriesByIndex = [:]
        olderTranscriptCursor = pageCursor
      } else if olderTranscriptCursor == nil {
        // First fetch establishes the scroll-back anchor; later contiguous
        // polls must not move it forward past pages the user already loaded.
        olderTranscriptCursor = pageCursor
      }
    } else {
      olderTranscriptCursor = min(olderTranscriptCursor ?? pageCursor, pageCursor)
    }
    for (offset, entry) in page.entries.enumerated() {
      transcriptEntriesByIndex[start + offset] = entry
    }
  }

  @MainActor
  func combinedTranscriptEntries() -> [AgentChatTranscriptEntry] {
    transcriptEntriesByIndex.keys.sorted().compactMap { transcriptEntriesByIndex[$0] }
  }

  var hasOlderTranscriptHistory: Bool {
    (olderTranscriptCursor ?? 0) > 0
  }

  /// Fetch the next strictly-older transcript page from the host and prepend
  /// it to the fallback entries that feed the chat timeline.
  @MainActor
  func loadOlderTranscriptEntries() async {
    guard !olderTranscriptLoading, let cursor = olderTranscriptCursor, cursor > 0 else { return }
    olderTranscriptLoading = true
    defer { olderTranscriptLoading = false }
    guard let page = try? await syncService.fetchChatTranscriptPage(
      sessionId: sessionId,
      cursor: cursor
    ) else { return }
    recordTranscriptPage(page, before: cursor)
    let combined = combinedTranscriptEntries()
    if !combined.isEmpty, combined != fallbackEntries {
      fallbackEntries = combined
    }
    // fallbackEntries only feed the timeline while `transcript` is empty
    // (buildWorkTimeline), so splice the older entries into the rendered
    // transcript right away — otherwise the fetched page stays invisible
    // until the next loadTranscript poll. preferredWorkTranscript backfills
    // by role+turnId+text identity, so entries already rendered from live
    // events are not duplicated.
    let olderTranscript = makeWorkChatTranscript(from: combined, sessionId: sessionId)
    let merged = preferredWorkTranscript(current: [], fallback: olderTranscript, eventTranscript: transcript)
    if !merged.isEmpty, merged != transcript {
      transcript = merged
    }
  }

  /// Re-read this session's row from the phone's local replicated DB. Cheap
  /// (no network) — keeps the @State row current with changeset-synced status
  /// transitions (idle → running → exited) while the view is open.
  @MainActor
  func refreshSessionRowFromLocalStore() async {
    guard let refreshed = try? await syncService.fetchSessions().first(where: { $0.id == sessionId }) else { return }
    if refreshed != session {
      session = refreshed
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
  func cleanupLoadedArtifactContent() {
    artifactContent.values.forEach { workRemoveLoadedArtifactTempFile($0) }
    artifactContent.removeAll()
    artifactContentLoadsInFlight.removeAll()
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

      for (artifactId, content) in artifactContent where !validArtifactIds.contains(artifactId) {
        workRemoveLoadedArtifactTempFile(content)
      }
      artifactContent = artifactContent.filter { validArtifactIds.contains($0.key) }
      artifactContentLoadsInFlight = Set(artifactContentLoadsInFlight.filter { validArtifactIds.contains($0) })

      for artifact in refreshed where previousURIs[artifact.id] != nil && previousURIs[artifact.id] != artifact.uri {
        workRemoveLoadedArtifactTempFile(artifactContent[artifact.id])
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
      if case .userMessage(let text, _, _, _, _, _) = envelope.event {
        return text.trimmingCharacters(in: .whitespacesAndNewlines) == prompt
      }
      return false
    }) {
      handledOpeningPromptKey = promptKey
      return
    }
    copySubmittedWorkPromptToPasteboard(prompt)
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
        workChatEventIncludedInIdleCanonicalEventTranscript(envelope.event)
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
    if !mergedTranscript.isEmpty, mergedTranscript != transcript {
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

    // We used to bail when fallbackEntries was non-empty, but loadTranscript
    // now populates fallbackEntries during active sessions too — so a populated
    // cache no longer means "we already reconciled". Rely on the active-status
    // gate plus the 6s debounce below to throttle work instead.
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
    let pendingSteerTexts = Set(
      derivePendingWorkSteers(from: transcript).map { normalizedWorkLocalEchoText($0.text) }
    )
    localEchoMessages.removeAll { echo in
      let normalizedEcho = normalizedWorkLocalEchoText(echo.text)
      if pendingSteerTexts.contains(normalizedEcho) {
        return true
      }
      return transcript.contains { envelope in
        guard case .userMessage(let text, _, _, let steerId, let deliveryState, _) = envelope.event else {
          return false
        }
        guard normalizedWorkLocalEchoText(text) == normalizedEcho else { return false }
        if deliveryState == "queued", steerId != nil {
          return false
        }
        return true
      }
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
    // liveTurnActiveHint keeps the loop eligible when a desktop-started turn
    // is streaming but the synced session row hasn't flipped to running yet —
    // the row catches up via refreshSessionRowFromLocalStore / the loop's own
    // summary refresh below.
    let initialStatus = normalizedWorkChatSessionStatus(session: session, summary: chatSummary)
    guard initialStatus == "active" || initialStatus == "awaiting-input" || liveTurnActiveHint else { return }
    while !Task.isCancelled, isLiveAndReachable,
      {
        let status = normalizedWorkChatSessionStatus(session: self.session, summary: self.chatSummary)
        return status == "active" || status == "awaiting-input" || self.liveTurnActiveHint
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
  @Environment(\.layoutDirection) private var layoutDirection
  @State private var contentWidth: CGFloat = 0

  let mode: WorkSessionNavigationChrome
  let title: String
  let trailingControls: () -> TrailingControls

  @ViewBuilder
  func body(content: Content) -> some View {
    switch mode {
    case .pushedDetail:
      content
        .background {
          GeometryReader { geometry in
            Color.clear
              .preference(key: WorkSessionNavigationChromeWidthPreferenceKey.self, value: geometry.size.width)
          }
        }
        .onPreferenceChange(WorkSessionNavigationChromeWidthPreferenceKey.self) { width in
          contentWidth = width
        }
        // Keep the edge gesture pass-through: vertical scrolls and row gestures
        // still reach the chat, while the helper only dismisses true edge swipes.
        .simultaneousGesture(edgeSwipeDismissGesture(containerWidth: contentWidth))
        .safeAreaInset(edge: .top, spacing: 0) {
          ZStack {
            Text(title)
              .font(.headline.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(1)
              .truncationMode(.tail)
              .frame(maxWidth: .infinity)
              .padding(.horizontal, 64)

            HStack(spacing: 10) {
              Button {
                dismiss()
              } label: {
                Image(systemName: "chevron.left")
                  .font(.system(size: 15, weight: .semibold))
                  .foregroundStyle(ADEColor.accent)
                  .frame(width: 28, height: 28)
              }
              .buttonStyle(.plain)
              .contentShape(Rectangle())
              .accessibilityLabel("Back to Work")

              Spacer(minLength: 0)

              trailingControls()
            }
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

  private func edgeSwipeDismissGesture(containerWidth: CGFloat) -> some Gesture {
    DragGesture(minimumDistance: 16, coordinateSpace: .local)
      .onEnded { value in
        guard containerWidth > 0 else { return }
        guard workSessionShouldDismissForEdgeSwipe(
          startX: value.startLocation.x,
          containerWidth: containerWidth,
          layoutDirection: layoutDirection,
          translation: value.translation,
          predictedEndTranslation: value.predictedEndTranslation
        ) else { return }
        dismiss()
      }
  }
}

private struct WorkSessionNavigationChromeWidthPreferenceKey: PreferenceKey {
  static var defaultValue: CGFloat = 0

  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
    value = nextValue()
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
