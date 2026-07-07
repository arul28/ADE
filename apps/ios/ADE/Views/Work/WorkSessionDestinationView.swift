import SwiftUI
import UIKit
import AVKit

enum WorkSessionNavigationChrome {
  case pushedDetail
  case embedded
}

extension WorkSessionNavigationChrome: Equatable {}

let workSessionEdgeSwipeActivationWidth: CGFloat = 36
let workSessionEdgeSwipeMinimumTranslation: CGFloat = 88
let workSessionEdgeSwipePredictedTranslation: CGFloat = 140
let workChatIdleLiveEventTailLimit = 48

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

func workChatLiveObservationKey(sessionId: String, chatEventRevision: Int) -> String {
  "\(sessionId)-\(chatEventRevision)"
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

func transcriptContainsResolvedSteer(_ transcript: [WorkChatEnvelope], steer: WorkPendingSteerModel) -> Bool {
  let steerId = steer.id
  let normalizedSteerText = normalizedQueuedSteerText(steer.text)
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
  guard !normalizedSteerText.isEmpty else { return false }
  for envelope in sortedWorkChatEnvelopes(transcript).reversed() {
    guard case .userMessage(let text, _, _, let candidate, let deliveryState, _) = envelope.event,
          normalizedQueuedSteerText(text) == normalizedSteerText
    else { continue }
    return candidate != steerId || deliveryState != "queued"
  }
  return false
}

func workChatShouldPreferFallbackTranscript(
  fallbackTranscript: [WorkChatEnvelope],
  sessionStatus: String,
  liveTranscript: [WorkChatEnvelope]
) -> Bool {
  guard !fallbackTranscript.isEmpty,
        sessionStatus != "active",
        !workTranscriptIndicatesActiveTurn(liveTranscript)
  else { return false }
  guard let liveTail = latestWorkTextEnvelope(in: liveTranscript) else { return true }
  guard let fallbackTail = latestWorkTextEnvelope(in: fallbackTranscript) else { return false }
  return fallbackTail.timestamp >= liveTail.timestamp
}

private func latestWorkTextEnvelope(in transcript: [WorkChatEnvelope]) -> WorkChatEnvelope? {
  for envelope in sortedWorkChatEnvelopes(transcript).reversed() {
    switch envelope.event {
    case .userMessage, .assistantText:
      return envelope
    default:
      continue
    }
  }
  return nil
}

func workChatTranscriptPreferenceStatus(
  sessionStatus: String,
  liveTurnActiveHint: Bool?
) -> String {
  if liveTurnActiveHint == false && sessionStatus == "active" {
    return "idle"
  }
  return sessionStatus
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

struct WorkLiveTranscriptCache {
  private var sessionId: String?
  private var eventCount = 0
  private var headEvent: AgentChatEventEnvelope?
  private var tailEvent: AgentChatEventEnvelope?
  private var transcript: [WorkChatEnvelope] = []
  private(set) var recentDeltaTranscript: [WorkChatEnvelope] = []
  private(set) var recentTranscriptWasRebuilt = false

  mutating func reset(sessionId: String? = nil) {
    self.sessionId = sessionId
    eventCount = 0
    headEvent = nil
    tailEvent = nil
    transcript = []
    recentDeltaTranscript = []
    recentTranscriptWasRebuilt = false
  }

  mutating func compact(sessionId: String, events: [AgentChatEventEnvelope]) {
    guard !events.isEmpty else {
      reset(sessionId: sessionId)
      return
    }
    self.sessionId = sessionId
    eventCount = events.count
    headEvent = events.first
    tailEvent = events.last
    transcript = makeWorkChatTranscript(from: events)
    recentDeltaTranscript = []
    recentTranscriptWasRebuilt = false
  }

  mutating func transcript(
    for sessionId: String,
    events: [AgentChatEventEnvelope]
  ) -> [WorkChatEnvelope] {
    guard !events.isEmpty else {
      reset(sessionId: sessionId)
      return []
    }

    if canAppend(sessionId: sessionId, events: events) {
      let appendedEvents = Array(events.dropFirst(eventCount))
      if !appendedEvents.isEmpty {
        let appendedTranscript = makeWorkChatTranscript(from: appendedEvents)
        recentDeltaTranscript = appendedTranscript
        recentTranscriptWasRebuilt = false
        transcript = appendWorkChatTranscripts(base: transcript, live: appendedTranscript)
      } else {
        recentDeltaTranscript = []
        recentTranscriptWasRebuilt = false
      }
    } else {
      transcript = makeWorkChatTranscript(from: events)
      // A rebase/replay rebuild is not a delta. Treating the rebuilt transcript
      // as "recent" re-appends old assistant chunks into the visible message and
      // creates repeated phrases during live streaming.
      recentDeltaTranscript = []
      recentTranscriptWasRebuilt = true
    }

    self.sessionId = sessionId
    eventCount = events.count
    headEvent = events.first
    tailEvent = events.last
    return transcript
  }

  private func canAppend(
    sessionId: String,
    events: [AgentChatEventEnvelope]
  ) -> Bool {
    guard self.sessionId == sessionId,
          eventCount <= events.count
    else { return false }

    if eventCount == 0 {
      return true
    }

    return headEvent == events.first
      && tailEvent == events[eventCount - 1]
  }
}

private struct WorkChatTranscriptPresentationCacheEntry {
  var transcript: [WorkChatEnvelope]
  var fallbackEntries: [AgentChatTranscriptEntry]
  var olderTranscriptCursor: Int?
  var olderChatEventHistoryCursor: Int?
  var storedAt: Date

  var hasVisibleTranscript: Bool {
    !transcript.isEmpty || !fallbackEntries.isEmpty
  }
}

@MainActor
private var workChatTranscriptPresentationCacheBySession: [String: WorkChatTranscriptPresentationCacheEntry] = [:]

private let workChatTranscriptPresentationCacheLimit = 8

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
  var forceFreshTranscriptOnOpen = false
  var showsLaneActions = true
  var navigationTitleOverride: String?
  /// Lanes forwarded to the chat composer for `@`-mention autocomplete.
  var lanes: [LaneSummary] = []
  /// Set when this chat is opened from the hub as a cross-project "quick look":
  /// the session lives in a project OTHER than the phone's active one and
  /// streams read-only without a project switch. Nil for the ordinary
  /// same-project path. When set, transcript/streaming/sends route to that
  /// project (via the sync scope registered on appear) and active-project-only
  /// affordances (local DB row observation, lane presence, PR badges, proof
  /// artifacts) are gated off — the existing full-detail path is untouched.
  var crossProjectContext: WorkChatCrossProjectContext?

  /// Whether this view is a cross-project "quick look" (see `crossProjectContext`).
  var isCrossProject: Bool { crossProjectContext != nil }

  @State var session: TerminalSessionSummary?
  @State var chatSummary: AgentChatSessionSummary?
  // Last non-nil summary this mounted instance ever observed. The composer's
  // model-picker + permission-mode row is gated on `summary.isAvailable`, so a
  // momentary nil summary would blank those controls mid-session. This latch
  // (plus the sync cache) backstops the coalesce in `composerChatSummary` so
  // once the controls have rendered they never disappear while the view stays
  // mounted.
  @State var lastKnownChatSummary: AgentChatSessionSummary?
  @State var transcript: [WorkChatEnvelope] = []
  @State var transcriptRenderSignature = 0
  @State var mainChatRenderEpoch = 0
  @State var liveTranscriptCache = WorkLiveTranscriptCache()
  @State var fallbackEntries: [AgentChatTranscriptEntry] = []
  @State var fallbackEntriesRenderSignature = 0
  // Canonical transcript entries keyed by their host-side index. Tail
  // refreshes overwrite the newest indices while "load earlier" pages fill
  // older ones, so a poll can never clobber scroll-back history. The cursor
  // is the oldest fetched index (0 = transcript head reached).
  @State var transcriptEntriesByIndex: [Int: AgentChatTranscriptEntry] = [:]
  @State var olderTranscriptCursor: Int?
  // Newer hosts page canonical chat JSONL by byte offset. Prefer this path for
  // scrollback because it keeps the websocket stream tail-sized while still
  // walking arbitrarily old transcript history.
  @State var olderChatEventHistoryCursor: Int?
  @State var olderTranscriptLoading = false
  @State var artifacts: [ComputerUseArtifactSummary] = []
  @State var artifactsRenderSignature = 0
  @State var localEchoMessages: [WorkLocalEchoMessage] = []
  @State var optimisticPendingSteers: [WorkPendingSteerModel] = []
  @State var subagentSnapshots: [WorkSubagentSnapshot] = []
  @State var remoteSubagentSnapshots: [WorkSubagentSnapshot] = []
  @State var subagentView: WorkSubagentSelection?
  @State var subagentTranscript: [WorkChatEnvelope] = []
  @State var subagentTranscriptRenderSignature = 0
  @State var parentTranscriptBeforeSubagent: [WorkChatEnvelope] = []
  @State var parentFallbackEntriesBeforeSubagent: [AgentChatTranscriptEntry] = []
  @State var subagentDrawerPresented = false
  @State var expandedSubagentDetailIds: Set<String> = []
  @State var probingSubagentTaskId: String?
  @State var remoteSubagentRefreshInFlight = false
  @State var expandedToolCardIds = Set<String>()
  @State var artifactContent: [String: WorkLoadedArtifactContent] = [:]
  @State var artifactContentRenderSignature = 0
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
  @State var lanePrSummary: PrSummary?
  @State var lanePrTag: LanePrTag?
  /// Lane the last completed PR resolve ran for; lets same-lane re-resolves
  /// keep showing the current PR instead of clearing it first.
  @State var lastResolvedPrLaneId: String?
  @State var prCreateCapabilities: PrCreateCapabilities?
  @State var createPrPresented = false
  @State var createPrAfterDetailsDismiss = false
  @State var prDetailsPresented = false
  @State var prDetailsSnapshot: PullRequestSnapshot?
  @State var prDetailsRefreshing = false
  @State var prDetailsError: String?
  @State var prLinkCopied = false
  @State var sessionActionRenamePresented = false
  @State var sessionActionRenameText = ""
  @State var sessionIdCopied = false
  @State var sessionDeepLinkCopied = false
  @State var lastSessionRowRefreshAt = Date.distantPast
  @State var lastTranscriptRemoteRefreshAt = Date.distantPast
  @State var lastEmptyTranscriptHydrationAt = Date.distantPast
  @State var lastCanonicalTranscriptRefreshAt = Date.distantPast
  @State var lastArtifactRefreshAt = Date.distantPast
  @State var initialTranscriptTailHydrated = false
  @State var openingLoadInFlight = false
  @State var emptyTranscriptHydrationInFlight = false
  @State var canonicalTranscriptRefreshInFlight = false
  @State var handledOpeningPromptKey: String?
  @State var stagedOpeningPromptKey: String?

  @MainActor
  func setTranscript(_ next: [WorkChatEnvelope]) {
    if transcript.isEmpty, !next.isEmpty {
      mainChatRenderEpoch &+= 1
    }
    transcript = next
    transcriptRenderSignature = workChatEnvelopeListRenderSignature(next)
    cacheCurrentTranscriptPresentationIfNeeded()
  }

  @MainActor
  func setFallbackEntries(_ next: [AgentChatTranscriptEntry]) {
    if transcript.isEmpty, fallbackEntries.isEmpty, !next.isEmpty {
      mainChatRenderEpoch &+= 1
    }
    fallbackEntries = next
    fallbackEntriesRenderSignature = workFallbackEntriesRenderSignature(next)
    cacheCurrentTranscriptPresentationIfNeeded()
  }

  @MainActor
  func resetTranscriptHistoryState() {
    transcriptEntriesByIndex = [:]
    olderTranscriptCursor = nil
    olderChatEventHistoryCursor = nil
    initialTranscriptTailHydrated = false
  }

  @MainActor
  func cacheCurrentTranscriptPresentationIfNeeded() {
    guard !transcript.isEmpty || !fallbackEntries.isEmpty else { return }
    workChatTranscriptPresentationCacheBySession[sessionId] = WorkChatTranscriptPresentationCacheEntry(
      transcript: transcript,
      fallbackEntries: fallbackEntries,
      olderTranscriptCursor: olderTranscriptCursor,
      olderChatEventHistoryCursor: olderChatEventHistoryCursor,
      storedAt: Date()
    )
    guard workChatTranscriptPresentationCacheBySession.count > workChatTranscriptPresentationCacheLimit else { return }
    let overflow = workChatTranscriptPresentationCacheBySession.count - workChatTranscriptPresentationCacheLimit
    let expiredSessionIds = workChatTranscriptPresentationCacheBySession
      .sorted { $0.value.storedAt < $1.value.storedAt }
      .prefix(overflow)
      .map(\.key)
    for expiredSessionId in expiredSessionIds {
      workChatTranscriptPresentationCacheBySession.removeValue(forKey: expiredSessionId)
    }
  }

  @MainActor
  func seedTranscriptFromPresentationCacheIfNeeded() {
    guard !forceFreshTranscriptOnOpen else { return }
    guard transcript.isEmpty,
          fallbackEntries.isEmpty,
          let cached = workChatTranscriptPresentationCacheBySession[sessionId],
          cached.hasVisibleTranscript
    else { return }

    olderTranscriptCursor = cached.olderTranscriptCursor
    olderChatEventHistoryCursor = cached.olderChatEventHistoryCursor
    if !cached.transcript.isEmpty {
      setTranscript(cached.transcript)
    }
    if !cached.fallbackEntries.isEmpty {
      setFallbackEntries(cached.fallbackEntries)
    }
    initialTranscriptTailHydrated = true
  }

  @MainActor
  func setArtifacts(_ next: [ComputerUseArtifactSummary]) {
    artifacts = next
    artifactsRenderSignature = workArtifactSummariesRenderSignature(next)
  }

  @MainActor
  func setSubagentTranscript(_ next: [WorkChatEnvelope]) {
    subagentTranscript = next
    subagentTranscriptRenderSignature = workChatEnvelopeListRenderSignature(next)
  }

  @MainActor
  func refreshArtifactContentRenderSignature() {
    artifactContentRenderSignature = workLoadedArtifactContentRenderSignature(artifactContent)
  }

  @MainActor
  func setArtifactContent(_ content: WorkLoadedArtifactContent, for artifactId: String) {
    artifactContent[artifactId] = content
    refreshArtifactContentRenderSignature()
  }

  @MainActor
  func removeArtifactContent(for artifactId: String) {
    artifactContent.removeValue(forKey: artifactId)
    refreshArtifactContentRenderSignature()
  }

  var sessionDestinationNavigationTitle: String {
    if let subagentView {
      return subagentView.name
    }
    if let navigationTitleOverride {
      return navigationTitleOverride
    }
    return chatSummary?.title ?? session?.title ?? "Session"
  }

  /// Summary the composer's model/permission controls render from. Every other
  /// status read coalesces `chatSummary ?? initialChatSummary`, but the composer
  /// context was the lone consumer reading bare `chatSummary` — so a
  /// push/deeplink rebuild (new `.id`, @State reset) that re-seeds from a nil
  /// `initialChatSummary` (the open session can be evicted from the summary
  /// cache by a partial Work-list refresh) blanked the controls. Coalesce
  /// through the seed, the in-view latch, and finally the durable sync cache so
  /// the controls survive both the rebuild and any transient nil.
  var composerChatSummary: AgentChatSessionSummary? {
    chatSummary
      ?? initialChatSummary
      ?? lastKnownChatSummary
      ?? syncService.chatSummaryCache[sessionId]
  }

  var subagentProvider: String? {
    chatSummary?.provider ?? workChatProviderFamilyFromToolType((session ?? initialSession)?.toolType)
  }

  var subagentCapability: WorkSubagentCapability {
    workResolveSubagentCapability(provider: subagentProvider)
  }

  var selectedSubagentSnapshot: WorkSubagentSnapshot? {
    guard let subagentView else { return nil }
    return subagentSnapshots.first { snapshot in
      snapshot.taskId == subagentView.taskId
        || snapshot.agentId == subagentView.taskId
        || (subagentView.agentId != nil && (snapshot.agentId == subagentView.agentId || snapshot.taskId == subagentView.agentId))
    }
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
  var liveTurnActiveHint: Bool? {
    syncService.chatTurnActiveHint(sessionId: sessionId)
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

  var headerMenuPrLookupKey: String {
    let laneId = headerMenuLaneId.trimmingCharacters(in: .whitespacesAndNewlines)
    let githubKey = syncService.laneGithubPrItems
      .map { "\($0.id):\($0.state):\($0.isDraft):\($0.updatedAt):\($0.linkedPrId ?? "")" }
      .joined(separator: "|")
    return "\(laneId)|\(syncService.prsProjectionRevision)|\(githubKey)"
  }

  /// Trailing nav-bar overflow menu for chat sessions: proof drawer plus lane
  /// shortcuts when the session is lane-backed.
  @ViewBuilder
  var sessionHeaderTrailingControls: some View {
    if let session, isChatSession(session) {
      HStack(spacing: 8) {
        if subagentView != nil {
          Button {
            Task { await dismissSubagentView() }
          } label: {
            Image(systemName: "chevron.left")
              .font(.system(size: 13, weight: .semibold))
              .foregroundStyle(ADEColor.accent)
              .frame(width: 30, height: 30)
              .background(ADEColor.surfaceBackground.opacity(0.9), in: Circle())
              .overlay(
                Circle()
                  .stroke(ADEColor.glassBorder.opacity(0.75), lineWidth: 0.5)
              )
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Back to main chat")
        }

        WorkChatHeaderMenu(
          model: headerMenuModel(session),
          onShowSubagents: { Task { await prepareSubagentDrawerPresentation() } },
          onShowProof: { artifactDrawerPresented = true },
          onViewPrDetails: { presentChatPrDetails() },
          onOpenPrsTab: { openLaneOpenPr() },
          onOpenGitHub: { openLanePrOnGitHub() },
          onCopyPrLink: { copyLanePrLink() },
          onOpenPrCreation: { openPrCreationInPrsTab() },
          onOpenLane: { openSessionLane() },
          onRename: { presentSessionRename() },
          onDelete: { Task { await deleteCurrentChatSession() } },
          onCopySessionId: { copyCurrentSessionId() },
          onCopySessionDeepLink: { copyCurrentSessionDeepLink() },
          onTogglePinned: { Task { await toggleCurrentSessionPinned() } }
        )
        .equatable()
      }
    } else {
      EmptyView()
    }
  }

  private func headerMenuModel(_ session: TerminalSessionSummary) -> WorkChatHeaderMenuModel {
    WorkChatHeaderMenuModel(
      subagentCount: subagentSnapshots.count,
      artifactCount: artifacts.count,
      showsLaneActions: showsLaneActions,
      prTag: lanePrTag,
      prGitHubUrlAvailable: !lanePrGitHubUrlString.isEmpty,
      prLinkCopied: prLinkCopied,
      laneAvailable: !headerMenuLaneId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      createPrBlockedReason: createPullRequestBlockedReason,
      sessionPinned: session.pinned,
      sessionIdCopied: sessionIdCopied,
      sessionDeepLinkCopied: sessionDeepLinkCopied
    )
  }

  var lanePrGitHubUrlString: String {
    (lanePrTag?.githubUrl ?? laneOpenPr?.githubUrl ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private var headerMenuLaneColor: Color? {
    let laneId = headerMenuLaneId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !laneId.isEmpty,
          let lane = lanes.first(where: { $0.id == laneId })
    else { return nil }
    return LaneColorPalette.color(forHex: lane.color)
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
      .sheet(isPresented: $subagentDrawerPresented) {
        WorkSubagentDrawerSheet(
          snapshots: subagentSnapshots,
          provider: subagentProvider,
          selectedTaskId: subagentView?.taskId,
          probingTaskId: probingSubagentTaskId,
          expandedTaskIds: $expandedSubagentDetailIds,
          onSelect: handleSubagentSelection
        )
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .task {
          await refreshRemoteSubagentSnapshots()
        }
      }
      .sheet(isPresented: $createPrPresented) {
        chatCreatePrWizardSheet
      }
      .sheet(isPresented: $prDetailsPresented, onDismiss: {
        if createPrAfterDetailsDismiss {
          createPrAfterDetailsDismiss = false
          createPrPresented = true
        }
      }) {
        WorkChatPrDetailsSheet(
          tag: lanePrTag,
          pr: laneOpenPr,
          summary: lanePrSummary,
          snapshot: prDetailsSnapshot,
          laneColor: headerMenuLaneColor,
          canCreate: canCreatePullRequestForHeaderLane,
          createBlockedReason: createPullRequestBlockedReason,
          isRefreshing: prDetailsRefreshing,
          errorMessage: prDetailsError,
          onRefresh: {
            Task { await refreshChatPrDetails(force: true) }
          },
          onCreate: {
            presentCreateLanePr()
          },
          onOpenPrsTab: {
            if lanePrTag == nil {
              openPrCreationInPrsTab()
            } else {
              openLaneOpenPr()
            }
          },
          onOpenGitHub: openLanePrOnGitHub
        )
        .presentationDetents([.height(500), .large])
        .presentationDragIndicator(.visible)
        .presentationContentInteraction(.scrolls)
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
        // Cross-project "quick look": register the foreign scope BEFORE load()
        // so every transcript/summary/send routes to that project without
        // switching the phone's active project.
        if let crossProjectContext {
          syncService.setCrossProjectChatScope(
            sessionId: sessionId,
            projectId: crossProjectContext.projectId,
            projectRootPath: crossProjectContext.projectRootPath
          )
        }
        mainChatRenderEpoch = 0
        liveTranscriptCache.reset(sessionId: sessionId)
        resetTranscriptHistoryState()
        session = initialSession
        chatSummary = initialChatSummary
        setTranscript(initialTranscript ?? [])
        seedTranscriptFromPresentationCacheIfNeeded()
        stageInitialOpeningPromptEchoIfNeeded()
        await load()
        await sendInitialOpeningPromptIfNeeded()
        refreshSubagentSnapshots()
        // Remote subagent probing hits the host; skip the eager pass for a
        // cross-project quick look (the drawer still loads it on demand).
        if !isCrossProject {
          await refreshRemoteSubagentSnapshots()
        }
      }
      .task(id: liveChatObservationKey) {
        reconcileChatSummaryModeFromCacheIfNeeded()
        syncTranscriptFromLiveEvents()
        await reconcileIdleCanonicalTranscriptIfNeeded()
      }
      .task(id: emptyTranscriptHydrationKey) {
        await hydrateEmptyTranscriptFromHostIfNeeded()
      }
      .task(id: sessionRowObservationKey) {
        // A cross-project quick look has no local DB row for this session (only
        // the active project is mirrored) — status comes from the streamed
        // chat summary / turn hint instead.
        guard !isCrossProject else { return }
        // Session rows arrive through CRDT-backed local DB updates, not chat
        // event streams. Observe work projection changes without also poking
        // proof refresh state on every normal chat revision.
        try? await Task.sleep(nanoseconds: 320_000_000)
        guard !Task.isCancelled else { return }
        // The session row is the status source for the stop button and the
        // poll-loop gate. Without this re-read, a turn started on desktop
        // while this view is open in an idle state never updates the local
        // @State row — the chat streams output but renders as frozen
        // (pollIfNeeded bails on non-active status and nothing else
        // observes the DB).
        guard shouldRefreshSessionRowFromLocalStore() else { return }
        await refreshSessionRowFromLocalStore()
      }
      .task(id: artifactObservationKey) {
        // Proof artifacts are served from the active project's projection; a
        // cross-project quick look has no access to the foreign project's proof
        // drawer, so leave it empty rather than querying the wrong project.
        guard !isCrossProject else { return }
        // Proof rows arrive through their own projection. Keep this separate
        // from work row refreshes so live chat deltas don't churn artifact
        // loading state.
        try? await Task.sleep(nanoseconds: 320_000_000)
        guard !Task.isCancelled else { return }
        await refreshArtifacts(force: false)
      }
      .task(id: session?.laneId ?? initialSession?.laneId ?? "") {
        await syncLanePresence()
      }
      .task(id: headerMenuPrLookupKey) {
        // PR + lane presence lookups read the active project's caches; skip
        // them for a cross-project quick look (the header hides lane/PR actions).
        guard !isCrossProject else { return }
        await resolveLaneOpenPr(for: headerMenuLaneId)
        await loadPrCreateCapabilitiesIfNeeded()
      }
      .task(id: pollingKey) {
        await pollIfNeeded()
      }
      .task(id: selectedSubagentPollingKey) {
        await pollSelectedSubagentTranscriptIfNeeded()
      }
      .onChange(of: chatSummary) { _, newValue in
        // Latch the last non-nil summary so the composer's model/permission
        // controls survive a transient nil while this view stays mounted.
        if let newValue {
          lastKnownChatSummary = newValue
        }
      }
      .onChange(of: transcript) { _, _ in
        refreshSubagentSnapshots()
      }
      .onChange(of: subagentDrawerPresented) { _, presented in
        guard presented else { return }
        Task { await refreshRemoteSubagentSnapshots() }
      }
      .onDisappear {
        if let announcedLaneId {
          syncService.releaseLaneOpen(laneId: announcedLaneId)
          self.announcedLaneId = nil
        }
        cleanupLoadedArtifactContent()
        let wasCrossProject = isCrossProject
        Task {
          try? await syncService.unsubscribeFromChatEvents(sessionId: sessionId)
        }
        // Drop the foreign routing so a later same-session open (e.g. after
        // activating the project) uses the normal active-project path. The
        // unsubscribe above doesn't need the scope (the host keys off sessionId).
        if wasCrossProject {
          syncService.clearCrossProjectChatScope(sessionId: sessionId)
        }
      }
  }

  @ViewBuilder
  var sessionDestinationRoot: some View {
    if let session {
      if isChatSession(session) {
        chatSessionDestinationRoot(for: session)
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

  @ViewBuilder
  private func chatSessionDestinationRoot(for session: TerminalSessionSummary) -> some View {
    let viewingSubagent = subagentView != nil
    makeWorkChatSessionView(for: session, viewingSubagent: viewingSubagent)
      .id(chatSessionDestinationRootId(for: session, viewingSubagent: viewingSubagent))
  }

  private func chatSessionDestinationRootId(
    for session: TerminalSessionSummary,
    viewingSubagent: Bool
  ) -> String {
    if viewingSubagent {
      return "subagent-\(subagentView?.taskId ?? "unknown")-\(subagentTranscriptRenderSignature)"
    }
    return "main-\(session.id)-\(mainChatRenderEpoch)"
  }

  private func makeWorkChatSessionView(
    for session: TerminalSessionSummary,
    viewingSubagent: Bool
  ) -> WorkChatSessionView {
    let transcriptForView = viewingSubagent ? subagentTranscript : transcript
    let fallbackEntriesForView: [AgentChatTranscriptEntry] = viewingSubagent ? [] : fallbackEntries
    let artifactsForView: [ComputerUseArtifactSummary] = viewingSubagent ? [] : artifacts
    let optimisticPendingSteersForView: [WorkPendingSteerModel] = viewingSubagent ? [] : optimisticPendingSteers
    let localEchoMessagesForView: [WorkLocalEchoMessage] = viewingSubagent ? [] : localEchoMessages
    let sessionStatus = normalizedWorkChatSessionStatus(session: session, summary: chatSummary)
    let shouldSteer = hostReachable && sessionStatus == "active"
    let chatPrBadge: WorkChatPrBadgeModel? = viewingSubagent
      ? nil
      : workChatPrBadgeModel(tag: lanePrTag, pr: laneOpenPr, summary: lanePrSummary)
    let openPrDetails: (() -> Void)? = viewingSubagent ? nil : { presentChatPrDetails() }
    let inputLockMessage: String? = viewingSubagent
      ? "Viewing subagent transcript. Return to main chat to send."
      : nil
    let openLaneAction: (() -> Void)? = showsLaneActions ? { openSessionLane() } : nil
    let dispatchSteerInlineAction: (@MainActor (String) async -> Void)?
    let dispatchSteerInterruptAction: (@MainActor (String) async -> Void)?
    if supportsManualSteerDispatch {
      dispatchSteerInlineAction = { text in await dispatchSteerInline(text) }
      dispatchSteerInterruptAction = { text in await dispatchSteerInterrupt(text) }
    } else {
      dispatchSteerInlineAction = nil
      dispatchSteerInterruptAction = nil
    }
    let resolvedSessionStatus: String? = viewingSubagent ? "ended" : sessionStatus
    let loadOlderTranscriptAction: (@MainActor () async -> Void)?
    if viewingSubagent || isCrossProject {
      // Cross-project quick looks show the subscribed tail only: the paged
      // history command routes through the project scope registry and would
      // boot the foreign runtime for a read.
      loadOlderTranscriptAction = nil
    } else {
      loadOlderTranscriptAction = { await loadOlderTranscriptEntries() }
    }
    return WorkChatSessionView(
      session: WorkChatSessionRenderContext(session),
      chatSummaryContext: WorkChatSummaryRenderContext(composerChatSummary),
      transcript: transcriptForView,
      transcriptRenderSignature: viewingSubagent ? subagentTranscriptRenderSignature : transcriptRenderSignature,
      fallbackEntries: fallbackEntriesForView,
      fallbackEntriesRenderSignature: viewingSubagent ? 0 : fallbackEntriesRenderSignature,
      artifacts: artifactsForView,
      artifactsRenderSignature: viewingSubagent ? 0 : artifactsRenderSignature,
      optimisticPendingSteers: optimisticPendingSteersForView,
      optimisticPendingSteersRenderSignature: viewingSubagent ? 0 : workPendingSteersRenderSignature(optimisticPendingSteers),
      localEchoMessages: localEchoMessagesForView,
      localEchoMessagesRenderSignature: viewingSubagent ? 0 : workLocalEchoMessagesRenderSignature(localEchoMessages),
      expandedToolCardIdsSnapshot: expandedToolCardIds,
      expandedToolCardIdsRenderSignature: workExpandedToolCardIdsRenderSignature(expandedToolCardIds),
      artifactContentRenderSignature: artifactContentRenderSignature,
      artifactDrawerPresentedSnapshot: artifactDrawerPresented,
      sendingSnapshot: sending,
      errorMessageSnapshot: errorMessage,
      expandedToolCardIds: $expandedToolCardIds,
      artifactContent: $artifactContent,
      fullscreenImage: $fullscreenImage,
      artifactDrawerPresented: $artifactDrawerPresented,
      artifactRefreshInFlight: artifactRefreshInFlight,
      artifactRefreshError: artifactRefreshError,
      sending: $sending,
      errorMessage: $errorMessage,
      isLive: isLiveAndReachable,
      hostUnreachable: syncService.connectionState.isHostUnreachable,
      canComposeMessages: canComposeChatMessages && !viewingSubagent,
      canSendMessages: canSendChatMessages && !viewingSubagent,
      sendWillQueue: sendWillQueueChatMessage || shouldSteer,
      sendWillQueueIsReconnect: sendWillQueueChatMessage,
      inputLockMessage: inputLockMessage,
      transitionNamespace: transitionNamespace,
      onOpenLane: openLaneAction,
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
      onDispatchSteerInline: dispatchSteerInlineAction,
      onDispatchSteerInterrupt: dispatchSteerInterruptAction,
      onSelectModel: selectModel,
      onSelectRuntimeMode: selectRuntimeMode,
      onSelectEffort: selectReasoningEffort,
      onSelectCodexFastMode: selectCodexFastMode,
      resolvedSessionStatus: resolvedSessionStatus,
      lanes: lanes,
      lanesRenderSignature: workLaneListRenderSignature(lanes),
      hasOlderTranscriptHistory: viewingSubagent ? false : hasOlderTranscriptHistory,
      onLoadOlderTranscript: loadOlderTranscriptAction,
      subagentSnapshots: subagentSnapshots,
      subagentSnapshotsRenderSignature: workSubagentSnapshotsRenderSignature(subagentSnapshots),
      selectedSubagentTaskId: subagentView?.taskId,
      onOpenSubagents: { Task { await prepareSubagentDrawerPresentation() } },
      prBadge: chatPrBadge,
      onOpenPrDetails: openPrDetails,
      liveTurnActiveHint: liveTurnActiveHint
    )
  }

  var pollingKey: String {
    let status = normalizedWorkChatSessionStatus(session: session, summary: chatSummary)
    // liveTurnActiveHint participates so a desktop-started turn (session row
    // still idle locally) restarts the poll task the moment the hint flips on.
    return "\(session?.id ?? sessionId)-\(status)-\(isLiveAndReachable)-\(liveTurnActiveHint.map(String.init) ?? "nil")"
  }

  var liveChatObservationKey: String {
    workChatLiveObservationKey(
      sessionId: sessionId,
      chatEventRevision: syncService.chatEventRevision(for: sessionId)
    )
  }

  var emptyTranscriptHydrationKey: String {
    "\(session?.id ?? sessionId)-empty:\(transcript.isEmpty)-fallback:\(fallbackEntries.isEmpty)-host:\(hostReachable)-local:\(syncService.localStateRevision)"
  }

  var selectedSubagentPollingKey: String {
    guard let selectedSubagentSnapshot,
          selectedSubagentSnapshot.status == .running
    else { return "paused" }
    return "\(sessionId)-\(selectedSubagentSnapshot.taskId)-running-\(isLiveAndReachable)"
  }

  var artifactObservationKey: String {
    "\(sessionId)-proof:\(syncService.proofArtifactsProjectionRevision)"
  }

  var sessionRowObservationKey: String {
    "\(sessionId)-work:\(syncService.workProjectionRevision)"
  }

  var trimmedInitialOpeningPrompt: String {
    initialOpeningPrompt?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  }

  @MainActor
  func syncLanePresence() async {
    // Lane presence is an active-project concern; a cross-project quick look
    // must not announce itself into a foreign project's lane presence.
    guard !isCrossProject else { return }
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
    guard !openingLoadInFlight else { return }
    openingLoadInFlight = true
    defer { openingLoadInFlight = false }

    do {
      if let fetchedSession = try await syncService.fetchSession(id: sessionId) {
        session = fetchedSession
      } else if session == nil, initialSession == nil, isLive, hostReachable {
        // A chat opened straight from the hub — e.g. just created into a
        // project activated in place — may not have its local session row yet
        // (created on the host, still in flight over the changeset stream).
        // Hydrate it from the host instead of flashing "Session unavailable".
        if let hydrated = await syncService.ensureSessionRowHydrated(sessionId: sessionId) {
          session = hydrated
        }
      }
      lastSessionRowRefreshAt = Date()
      await refreshChatSummaryFromHost()
      // Proof artifacts are active-project-scoped; skip for a cross-project
      // quick look (the drawer stays empty rather than querying the wrong project).
      if !isCrossProject && !syncService.prefersReducedSyncLoad {
        await refreshArtifacts(force: true)
      }
      await loadTranscript(forceRemote: shouldHydrateTranscriptFromHost, preferLightweight: syncService.prefersReducedSyncLoad)
      await hydrateEmptyTranscriptFromHostIfNeeded()
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  var shouldHydrateTranscriptFromHost: Bool {
    guard hostReachable,
          let currentSession = session ?? initialSession,
          isChatSession(currentSession)
    else { return false }
    return true
  }

  /// Fold a cache-side mode patch (applied by SyncService when a
  /// `session_meta_updated` event arrives from another client) into the live
  /// `chatSummary` so the composer's model/permission pill reflects the change
  /// without a refetch. Runs on the chat-event revision bump the meta event
  /// already triggers. `mergeModeFields` mirrors the cache's cursor fields
  /// wholesale (the cache is authoritative), so an explicit `cursorModeId` /
  /// `cursorConfigValues` clear folded into the cache reaches the live composer
  /// here; the assignment is gated on a real change to avoid needless
  /// re-renders. When `chatSummary` is nil the composer already reads the
  /// patched cache via `composerChatSummary`, so nothing to do here.
  @MainActor
  func reconcileChatSummaryModeFromCacheIfNeeded() {
    guard var current = chatSummary,
          let cached = syncService.chatSummaryCache[sessionId],
          cached.sessionId == current.sessionId
    else { return }
    current.mergeModeFields(from: cached)
    if current != chatSummary {
      chatSummary = current
    }
  }

  @MainActor
  func refreshChatSummaryFromHost() async {
    if chatSummary == nil, let cached = syncService.chatSummaryCache[sessionId] {
      chatSummary = cached
    }

    // Cross-project quick look reads come from the chat_subscribe snapshot +
    // live tail, which the brain serves WITHOUT booting the foreign project.
    // The scoped chat.getSummary command routes through the project scope
    // registry and would spin up that project's runtime just to look.
    guard !isCrossProject else { return }

    if syncService.supportsRemoteAction("chat.getSummary"),
       let fetchedSummary = try? await syncService.fetchChatSummary(sessionId: sessionId) {
      if chatSummary != fetchedSummary {
        chatSummary = fetchedSummary
      }
      syncService.cacheChatSummary(fetchedSummary)
      return
    }

    guard let laneId = (session ?? initialSession)?.laneId,
          !laneId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          syncService.supportsRemoteAction("chat.listSessions"),
          let summaries = try? await syncService.listChatSessions(laneId: laneId),
          let fallbackSummary = summaries.first(where: { $0.sessionId == sessionId })
    else { return }

    if chatSummary != fallbackSummary {
      chatSummary = fallbackSummary
    }
    syncService.cacheChatSummary(fallbackSummary)
  }

  @MainActor
  func hydrateEmptyTranscriptFromHostIfNeeded(force: Bool = false) async {
    guard transcript.isEmpty,
          fallbackEntries.isEmpty,
          shouldHydrateTranscriptFromHost,
          !emptyTranscriptHydrationInFlight,
          force || !openingLoadInFlight
    else { return }

    let now = Date()
    guard force || now.timeIntervalSince(lastEmptyTranscriptHydrationAt) >= 2 else { return }

    emptyTranscriptHydrationInFlight = true
    lastEmptyTranscriptHydrationAt = now
    defer { emptyTranscriptHydrationInFlight = false }

    await refreshChatSummaryFromHost()
    await loadTranscript(forceRemote: true, preferLightweight: false)
  }

  @MainActor
  func loadTranscript(forceRemote: Bool, preferLightweight: Bool = false) async {
    seedTranscriptFromPresentationCacheIfNeeded()
    let forceOpeningTranscriptRefresh = forceFreshTranscriptOnOpen && !initialTranscriptTailHydrated

    let status = normalizedWorkChatSessionStatus(session: session ?? initialSession, summary: chatSummary ?? initialChatSummary)
    let transcriptStatus = workChatTranscriptPreferenceStatus(
      sessionStatus: status,
      liveTurnActiveHint: syncService.chatTurnActiveHint(sessionId: sessionId)
    )

    if forceRemote, let currentSession = session ?? initialSession, isChatSession(currentSession) {
      let alreadySubscribed = syncService.subscribedChatSessionIds.contains(sessionId)
      let hasReusablePresentation = workChatTranscriptPresentationCacheBySession[sessionId]?.hasVisibleTranscript == true
      let hasCachedEventHistory = !syncService.chatEventHistory(sessionId: sessionId).isEmpty
      let needsOpeningSnapshot = forceOpeningTranscriptRefresh
        || (transcript.isEmpty && fallbackEntries.isEmpty && !hasReusablePresentation && !hasCachedEventHistory)
      if status == "active" {
        // First visit subscribes (the host answers with a snapshot or a
        // sinceSeq replay). Once subscribed, live chat_event push plus the
        // host's transcript pump cover continuity — re-requesting a full
        // byte-capped snapshot on every 8s poll was redundant wire traffic
        // and a full dedupe/sort merge on the phone mid-stream.
        try? await syncService.subscribeToChatEvents(
          sessionId: sessionId,
          requestSnapshot: !alreadySubscribed || needsOpeningSnapshot
        )
      } else if needsOpeningSnapshot {
        // Active streaming stays on reduced snapshots for performance, but an
        // idle detail view must reconcile against a full event snapshot. A
        // reduced JSONL tail can start mid-message and render as a broken
        // final transcript until the canonical transcript fetch lands.
        try? await syncService.requestFullChatEventSnapshot(sessionId: sessionId)
      }

      // Quick looks stay on the chat_subscribe snapshot/tail — the canonical
      // history commands route through the project scope registry and would
      // boot the foreign runtime for a read (the cost this mode exists to avoid).
      let shouldHydrateCanonicalEventTail = !isCrossProject && (
        !preferLightweight
        || transcript.isEmpty
        || transcriptStatus != "active"
        || !initialTranscriptTailHydrated
        || forceOpeningTranscriptRefresh
      )
      if shouldHydrateCanonicalEventTail {
        do {
          if syncService.supportsRemoteAction("chat.getChatEventHistory") {
            let snapshot = try await syncService.hydrateChatEventHistorySnapshot(sessionId: sessionId)
            seedOlderChatEventHistoryCursor(from: snapshot)
            if (snapshot.tailStartOffset ?? 0) <= 0,
               (snapshot.windowTruncated == true || snapshot.truncated),
               syncService.supportsRemoteAction("chat.getChatEventHistoryPage") {
              if let page = try? await syncService.hydrateChatEventHistoryTailPage(sessionId: sessionId) {
                seedOlderChatEventHistoryCursor(from: page)
              }
            }
          } else if syncService.supportsRemoteAction("chat.getChatEventHistoryPage") {
            let page = try await syncService.hydrateChatEventHistoryTailPage(sessionId: sessionId)
            seedOlderChatEventHistoryCursor(from: page)
          }
        } catch {
          if syncService.supportsRemoteAction("chat.getChatEventHistoryPage") {
            if let page = try? await syncService.hydrateChatEventHistoryTailPage(sessionId: sessionId) {
              seedOlderChatEventHistoryCursor(from: page)
            }
          }
        }
      }
    }

    let liveTranscript = liveTranscriptCache.transcript(
      for: sessionId,
      events: syncService.chatEventHistory(sessionId: sessionId)
    )
    let liveDeltaTranscript = liveTranscriptCache.recentDeltaTranscript
    let liveTranscriptWasRebuilt = liveTranscriptCache.recentTranscriptWasRebuilt
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
    let needsInitialTailHydration = forceRemote && !initialTranscriptTailHydrated
    // Cross-project quick looks never take the command-based fallback fetch —
    // chat.getTranscript routes through the project scope registry and boots
    // the foreign runtime for a read.
    let shouldFetchFallback = !isCrossProject && (
      forceOpeningTranscriptRefresh
      || needsInitialTailHydration
      || !preferLightweight
      || (liveTranscript.isEmpty && transcript.isEmpty)
      || (!liveTranscript.isEmpty && transcriptStatus != "active")
    )
    let fallbackMaxChars = transcriptStatus == "active" ? 240_000 : 600_000
    if shouldFetchFallback, let page = try? await syncService.fetchChatTranscriptPage(sessionId: sessionId, maxChars: fallbackMaxChars) {
      recordTranscriptPage(page, before: nil)
      initialTranscriptTailHydrated = true
      fetchedFallbackEntries = combinedTranscriptEntries()
      fetchedFallbackEntriesAvailable = true
      fallbackTranscript = makeWorkChatTranscript(from: fetchedFallbackEntries, sessionId: sessionId)
    }

    // Chat-only fallback: parses chat envelopes out of the raw terminal buffer.
    // Terminal sessions own their subscription via TerminalSessionScreen's
    // offset stream; a preview-budget subscribe here would race a second
    // replace-snapshot into that stream.
    // Terminal buffers are active-project scoped; a quick-look must not
    // subscribe them (wrong project, and another read-path boot vector).
    if forceRemote && !preferLightweight && !isCrossProject, let currentSession = session ?? initialSession, isChatSession(currentSession) {
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

    let shouldPreferFallbackTranscript = workChatShouldPreferFallbackTranscript(
      fallbackTranscript: fallbackTranscript,
      sessionStatus: transcriptStatus,
      liveTranscript: eventTranscript
    )
    let canonicalEventTranscript: [WorkChatEnvelope]
    if shouldPreferFallbackTranscript {
      canonicalEventTranscript = eventTranscript.filter { envelope in
        workChatEventIncludedInIdleCanonicalEventTranscript(envelope.event)
      }
    } else {
      canonicalEventTranscript = eventTranscript
    }

    // Live event history is already the source of truth for the current tail.
    // Re-merging it into `transcript` replays delta chunks into the same
    // assistant item on every refresh, which duplicates text only on iOS.
    let mergedTranscript: [WorkChatEnvelope]
    let liveTranscriptStillMoving = transcriptStatus == "active" || workTranscriptIndicatesActiveTurn(eventTranscript)
    if !shouldPreferFallbackTranscript,
       !liveDeltaTranscript.isEmpty,
       !transcript.isEmpty {
      mergedTranscript = appendWorkChatTranscripts(base: transcript, live: liveDeltaTranscript)
    } else if !shouldPreferFallbackTranscript,
       liveTranscriptWasRebuilt,
       !transcript.isEmpty {
      mergedTranscript = preferredWorkTranscript(
        current: transcript,
        fallback: fallbackTranscript,
        eventTranscript: canonicalEventTranscript
      )
    } else if !shouldPreferFallbackTranscript,
       !needsInitialTailHydration,
       liveTranscriptStillMoving,
       !transcript.isEmpty {
      mergedTranscript = transcript
    } else {
      mergedTranscript = preferredWorkTranscript(
        current: [],
        fallback: fallbackTranscript,
        eventTranscript: canonicalEventTranscript
      )
    }
    if !mergedTranscript.isEmpty, mergedTranscript != transcript {
      setTranscript(mergedTranscript)
    }
    if fetchedFallbackEntriesAvailable, fallbackEntries != fetchedFallbackEntries {
      setFallbackEntries(fetchedFallbackEntries)
    }
    reconcileOptimisticPendingSteers(with: mergedTranscript)
    reconcileLocalEchoMessages()
    pruneIdleLiveChatEventHistoryIfNeeded(transcriptStatus: transcriptStatus, eventTranscript: eventTranscript)
    if forceRemote {
      lastTranscriptRemoteRefreshAt = Date()
    }
  }

  @MainActor
  func pruneIdleLiveChatEventHistoryIfNeeded(
    transcriptStatus: String,
    eventTranscript: [WorkChatEnvelope]
  ) {
    guard transcriptStatus != "active",
          liveTurnActiveHint != true,
          !workTranscriptIndicatesActiveTurn(eventTranscript)
    else { return }
    let compactedEvents = syncService.pruneChatEventHistory(
      sessionId: sessionId,
      keepingTail: workChatIdleLiveEventTailLimit
    )
    liveTranscriptCache.compact(sessionId: sessionId, events: compactedEvents)
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
  func seedOlderChatEventHistoryCursor(from snapshot: AgentChatEventHistorySnapshot) {
    updateOlderChatEventHistoryCursor(snapshot.tailStartOffset)
  }

  @MainActor
  func seedOlderChatEventHistoryCursor(from page: AgentChatEventHistoryPage) {
    guard page.sessionFound else {
      olderChatEventHistoryCursor = nil
      return
    }
    updateOlderChatEventHistoryCursor(page.hasMore ? page.startOffset : nil)
  }

  @MainActor
  func updateOlderChatEventHistoryCursor(_ cursor: Int?) {
    guard let cursor, cursor > 0 else {
      olderChatEventHistoryCursor = nil
      return
    }
    if let existing = olderChatEventHistoryCursor, existing > 0 {
      olderChatEventHistoryCursor = min(existing, cursor)
    } else {
      olderChatEventHistoryCursor = cursor
    }
  }

  @MainActor
  func combinedTranscriptEntries() -> [AgentChatTranscriptEntry] {
    transcriptEntriesByIndex.keys.sorted().compactMap { transcriptEntriesByIndex[$0] }
  }

  var hasOlderTranscriptHistory: Bool {
    (olderChatEventHistoryCursor ?? 0) > 0 || (olderTranscriptCursor ?? 0) > 0
  }

  /// Fetch the next strictly-older transcript page from the host and prepend
  /// it to the fallback entries that feed the chat timeline.
  @MainActor
  func loadOlderTranscriptEntries() async {
    guard !olderTranscriptLoading else { return }
    olderTranscriptLoading = true
    defer { olderTranscriptLoading = false }
    if await loadOlderChatEventHistoryPageIfPossible() {
      return
    }
    guard let cursor = olderTranscriptCursor, cursor > 0 else { return }
    guard let page = try? await syncService.fetchChatTranscriptPage(
      sessionId: sessionId,
      cursor: cursor
    ) else { return }
    recordTranscriptPage(page, before: cursor)
    let combined = combinedTranscriptEntries()
    if !combined.isEmpty, combined != fallbackEntries {
      setFallbackEntries(combined)
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
      setTranscript(merged)
    }
  }

  @MainActor
  func loadOlderChatEventHistoryPageIfPossible() async -> Bool {
    guard syncService.supportsRemoteAction("chat.getChatEventHistoryPage"),
          var cursor = olderChatEventHistoryCursor,
          cursor > 0
    else { return false }

    for _ in 0..<6 {
      guard cursor > 0 else { break }
      guard let page = try? await syncService.fetchChatEventHistoryPage(
        sessionId: sessionId,
        beforeOffset: cursor
      ) else {
        return false
      }
      guard page.sessionFound else {
        olderChatEventHistoryCursor = nil
        return true
      }
      guard page.startOffset < cursor else {
        olderChatEventHistoryCursor = nil
        return true
      }
      olderChatEventHistoryCursor = page.hasMore && page.startOffset > 0 ? page.startOffset : nil
      cursor = page.startOffset

      let olderTranscript = makeWorkChatTranscript(from: page.events)
      guard !olderTranscript.isEmpty else { continue }

      let merged = pruneResolvedQueuedSteerEnvelopes(
        mergeWorkChatTranscripts(base: olderTranscript, live: transcript)
      )
      if !merged.isEmpty, merged != transcript {
        setTranscript(merged)
      }
      return true
    }

    return true
  }

  /// Re-read this session's row from the phone's local replicated DB. Cheap
  /// (no network) — keeps the @State row current with changeset-synced status
  /// transitions (idle → running → exited) while the view is open.
  @MainActor
  func sessionRowRefreshMinimumInterval() -> TimeInterval {
    let status = normalizedWorkChatSessionStatus(session: session ?? initialSession, summary: chatSummary ?? initialChatSummary)
    if liveTurnActiveHint == true || status == "active" || status == "awaiting-input" {
      return 0.75
    }
    return syncService.prefersReducedSyncLoad ? 8.0 : 4.0
  }

  @MainActor
  func shouldRefreshSessionRowFromLocalStore(now: Date = Date()) -> Bool {
    now.timeIntervalSince(lastSessionRowRefreshAt) >= sessionRowRefreshMinimumInterval()
  }

  @MainActor
  func refreshSessionRowFromLocalStore() async {
    lastSessionRowRefreshAt = Date()
    guard let refreshed = try? await syncService.fetchSession(id: sessionId) else { return }
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
    await refreshChatSummaryFromHost()
    if let refreshedSession = try? await syncService.fetchSession(id: sessionId) {
      session = refreshedSession
    }
  }

  @MainActor
  func cleanupLoadedArtifactContent() {
    artifactContent.values.forEach { workRemoveLoadedArtifactTempFile($0) }
    artifactContent.removeAll()
    refreshArtifactContentRenderSignature()
    artifactContentLoadsInFlight.removeAll()
  }

  @MainActor
  func refreshArtifacts(force: Bool) async {
    // Proof artifacts live in the active project's projection; a cross-project
    // quick look has no access to the foreign project's proof drawer.
    guard !isCrossProject else { return }
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
      refreshArtifactContentRenderSignature()
      artifactContentLoadsInFlight = Set(artifactContentLoadsInFlight.filter { validArtifactIds.contains($0) })

      for artifact in refreshed where previousURIs[artifact.id] != nil && previousURIs[artifact.id] != artifact.uri {
        workRemoveLoadedArtifactTempFile(artifactContent[artifact.id])
        removeArtifactContent(for: artifact.id)
      }

      if artifacts != refreshed {
        setArtifacts(refreshed)
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
    let liveTranscript = liveTranscriptCache.transcript(
      for: sessionId,
      events: syncService.chatEventHistory(sessionId: sessionId)
    )
    let liveDeltaTranscript = liveTranscriptCache.recentDeltaTranscript
    let liveTranscriptWasRebuilt = liveTranscriptCache.recentTranscriptWasRebuilt
    guard !liveTranscript.isEmpty else { return }
    let status = normalizedWorkChatSessionStatus(session: session ?? initialSession, summary: chatSummary ?? initialChatSummary)
    let transcriptStatus = workChatTranscriptPreferenceStatus(
      sessionStatus: status,
      liveTurnActiveHint: syncService.chatTurnActiveHint(sessionId: sessionId)
    )
    guard !liveDeltaTranscript.isEmpty || liveTranscriptWasRebuilt || transcript.isEmpty else {
      pruneIdleLiveChatEventHistoryIfNeeded(transcriptStatus: transcriptStatus, eventTranscript: liveTranscript)
      return
    }
    let fallbackTranscript = makeWorkChatTranscript(from: fallbackEntries, sessionId: sessionId)
    let shouldPreferFallbackTranscript = workChatShouldPreferFallbackTranscript(
      fallbackTranscript: fallbackTranscript,
      sessionStatus: transcriptStatus,
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
    // Active live ticks should only fold the new event delta. Full fallback
    // backfill remains for idle/terminal reconciliation where completeness beats
    // per-frame streaming cost.
    let mergedTranscript: [WorkChatEnvelope]
    if !shouldPreferFallbackTranscript,
       !liveDeltaTranscript.isEmpty,
       !transcript.isEmpty {
      mergedTranscript = appendWorkChatTranscripts(base: transcript, live: liveDeltaTranscript)
    } else if !shouldPreferFallbackTranscript,
       liveTranscriptWasRebuilt,
       !transcript.isEmpty {
      mergedTranscript = preferredWorkTranscript(
        current: transcript,
        fallback: fallbackTranscript,
        eventTranscript: canonicalLiveTranscript
      )
    } else {
      mergedTranscript = preferredWorkTranscript(
        current: [],
        fallback: fallbackTranscript,
        eventTranscript: canonicalLiveTranscript
      )
    }
    if !mergedTranscript.isEmpty, mergedTranscript != transcript {
      setTranscript(mergedTranscript)
    }
    reconcileOptimisticPendingSteers(with: mergedTranscript)
    reconcileLocalEchoMessages()
    pruneIdleLiveChatEventHistoryIfNeeded(transcriptStatus: transcriptStatus, eventTranscript: liveTranscript)
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
      transcriptContainsResolvedSteer(transcript, steer: steer) || pendingIds.contains(steer.id)
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
  func refreshSubagentSnapshots() {
    let local = buildWorkSubagentSnapshots(from: transcript)
    let next = mergeWorkSubagentSnapshots(local: local, remote: remoteSubagentSnapshots)
    if next != subagentSnapshots {
      subagentSnapshots = next
    }
    if let subagentView,
       let updated = next.first(where: { snapshot in
         snapshot.taskId == subagentView.taskId
           || snapshot.agentId == subagentView.taskId
           || (subagentView.agentId != nil && (snapshot.agentId == subagentView.agentId || snapshot.taskId == subagentView.agentId))
       }) {
      let selection = workSubagentSelection(from: updated)
      if selection != subagentView {
        self.subagentView = selection
      }
    }
  }

  @MainActor
  func refreshRemoteSubagentSnapshots() async {
    guard subagentCapability.canList,
          !remoteSubagentRefreshInFlight
    else { return }
    remoteSubagentRefreshInFlight = true
    defer { remoteSubagentRefreshInFlight = false }
    do {
      let remote = try await syncService.fetchSubagents(sessionId: sessionId)
      let snapshots = remote.map(workSubagentSnapshot(from:))
      if snapshots != remoteSubagentSnapshots {
        remoteSubagentSnapshots = snapshots
        refreshSubagentSnapshots()
      }
    } catch {
      // Drawer hydration is opportunistic; the local transcript-derived roster
      // stays usable when an older desktop build lacks chat.listSubagents.
    }
  }

  @MainActor
  func clearSubagentView() {
    subagentView = nil
    setSubagentTranscript([])
    probingSubagentTaskId = nil
  }

  @MainActor
  func rememberParentTranscriptBeforeSubagent() {
    guard !transcript.isEmpty || !fallbackEntries.isEmpty else { return }
    parentTranscriptBeforeSubagent = transcript
    parentFallbackEntriesBeforeSubagent = fallbackEntries
  }

  @MainActor
  func restoreParentTranscriptAfterSubagentIfNeeded() {
    if transcript.isEmpty, !parentTranscriptBeforeSubagent.isEmpty {
      setTranscript(parentTranscriptBeforeSubagent)
    }
    if fallbackEntries.isEmpty, !parentFallbackEntriesBeforeSubagent.isEmpty {
      setFallbackEntries(parentFallbackEntriesBeforeSubagent)
    }
    parentTranscriptBeforeSubagent = []
    parentFallbackEntriesBeforeSubagent = []
  }

  @MainActor
  func materializeParentTranscriptFromLiveEventsIfNeeded() {
    guard transcript.isEmpty, fallbackEntries.isEmpty else { return }
    let liveTranscript = liveTranscriptCache.transcript(
      for: sessionId,
      events: syncService.chatEventHistory(sessionId: sessionId)
    )
    guard !liveTranscript.isEmpty else { return }
    let merged = preferredWorkTranscript(current: [], fallback: [], eventTranscript: liveTranscript)
    if !merged.isEmpty {
      setTranscript(merged)
    }
  }

  @MainActor
  func prepareSubagentDrawerPresentation() async {
    materializeParentTranscriptFromLiveEventsIfNeeded()
    if transcript.isEmpty && fallbackEntries.isEmpty && shouldHydrateTranscriptFromHost {
      await refreshChatSummaryFromHost()
      await loadTranscript(forceRemote: true, preferLightweight: false)
    }
    materializeParentTranscriptFromLiveEventsIfNeeded()
    rememberParentTranscriptBeforeSubagent()
    subagentDrawerPresented = true
    await refreshRemoteSubagentSnapshots()
  }

  @MainActor
  func dismissSubagentView() async {
    guard subagentView != nil else { return }

    if transcript.isEmpty && fallbackEntries.isEmpty && shouldHydrateTranscriptFromHost {
      await refreshChatSummaryFromHost()
      await loadTranscript(forceRemote: true, preferLightweight: false)
    }

    clearSubagentView()
    restoreParentTranscriptAfterSubagentIfNeeded()
    materializeParentTranscriptFromLiveEventsIfNeeded()

    if transcript.isEmpty && fallbackEntries.isEmpty && shouldHydrateTranscriptFromHost {
      await hydrateEmptyTranscriptFromHostIfNeeded(force: true)
    }
  }

  @MainActor
  func handleSubagentSelection(_ snapshot: WorkSubagentSnapshot) async {
    if let subagentView,
       snapshot.taskId == subagentView.taskId
        || snapshot.agentId == subagentView.taskId
        || (subagentView.agentId != nil && (snapshot.agentId == subagentView.agentId || snapshot.taskId == subagentView.agentId)) {
      await dismissSubagentView()
      subagentDrawerPresented = false
      return
    }

    guard subagentCapability.canViewFullTranscript else {
      toggleExpandedSubagentDetail(snapshot.taskId)
      return
    }

    guard snapshot.status == .running else {
      toggleExpandedSubagentDetail(snapshot.taskId)
      return
    }

    rememberParentTranscriptBeforeSubagent()

    probingSubagentTaskId = snapshot.taskId
    defer { probingSubagentTaskId = nil }

    do {
      let messages = try await syncService.fetchSubagentTranscript(
        sessionId: sessionId,
        agentId: snapshot.agentId ?? snapshot.taskId,
        taskId: snapshot.taskId,
        laneId: (session ?? initialSession)?.laneId,
        limit: 200
      )
      guard let messages, !messages.isEmpty else {
        toggleExpandedSubagentDetail(snapshot.taskId)
        return
      }
      let subagentEnvelopes = workSubagentTranscriptToEnvelopes(messages: messages, sessionId: sessionId)
      guard workSubagentTranscriptHasVisibleTimeline(subagentEnvelopes) else {
        toggleExpandedSubagentDetail(snapshot.taskId)
        return
      }
      setSubagentTranscript(subagentEnvelopes)
      await Task.yield()
      subagentView = workSubagentSelection(from: snapshot)
      expandedSubagentDetailIds.remove(snapshot.taskId)
      subagentDrawerPresented = false
    } catch {
      toggleExpandedSubagentDetail(snapshot.taskId)
    }
  }

  @MainActor
  func toggleExpandedSubagentDetail(_ taskId: String) {
    if expandedSubagentDetailIds.contains(taskId) {
      expandedSubagentDetailIds.remove(taskId)
    } else {
      expandedSubagentDetailIds.insert(taskId)
    }
  }

  @MainActor
  func refreshSelectedSubagentTranscript() async {
    guard let selectedSubagentSnapshot,
          subagentCapability.canViewFullTranscript
    else { return }
    guard let messages = try? await syncService.fetchSubagentTranscript(
      sessionId: sessionId,
      agentId: selectedSubagentSnapshot.agentId ?? selectedSubagentSnapshot.taskId,
      taskId: selectedSubagentSnapshot.taskId,
      laneId: (session ?? initialSession)?.laneId,
      limit: 200
    ), !messages.isEmpty else { return }
    let next = workSubagentTranscriptToEnvelopes(messages: messages, sessionId: sessionId)
    guard workSubagentTranscriptHasVisibleTimeline(next) else { return }
    if next != subagentTranscript {
      setSubagentTranscript(next)
    }
  }

  @MainActor
  func pollSelectedSubagentTranscriptIfNeeded() async {
    guard isLiveAndReachable,
          selectedSubagentSnapshot?.status == .running
    else { return }
    while !Task.isCancelled,
          isLiveAndReachable,
          selectedSubagentSnapshot?.status == .running {
      await refreshSelectedSubagentTranscript()
      try? await Task.sleep(nanoseconds: 1_500_000_000)
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
    guard liveTurnActiveHint != false,
          initialStatus == "active" || initialStatus == "awaiting-input" || liveTurnActiveHint == true
    else { return }
    while !Task.isCancelled, isLiveAndReachable,
      {
        guard self.liveTurnActiveHint != false else { return false }
        let status = normalizedWorkChatSessionStatus(session: self.session, summary: self.chatSummary)
        return status == "active" || status == "awaiting-input" || self.liveTurnActiveHint == true
      }() {
      syncTranscriptFromLiveEvents()
      let now = Date()
      if now.timeIntervalSince(lastTranscriptRemoteRefreshAt) >= 8 {
        await loadTranscript(forceRemote: true, preferLightweight: syncService.prefersReducedSyncLoad)
      }
      let sessionRefreshInterval = syncService.prefersReducedSyncLoad ? 10.0 : 5.0
      if now.timeIntervalSince(lastSessionRowRefreshAt) >= sessionRefreshInterval {
        lastSessionRowRefreshAt = now
        await refreshChatSummaryFromHost()
        if let refreshedSession = try? await syncService.fetchSession(id: sessionId) {
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

private func workInitialTranscriptSeedRenderSignature(_ transcript: [WorkChatEnvelope]?) -> Int {
  guard let transcript else { return 0 }
  var hasher = Hasher()
  hasher.combine(transcript.count)
  if let first = transcript.first {
    hasher.combine(workChatEnvelopeMergeKey(first))
    hasher.combine(first.sequence)
    hasher.combine(first.timestamp)
  }
  if let last = transcript.last {
    hasher.combine(workChatEnvelopeMergeKey(last))
    hasher.combine(last.sequence)
    hasher.combine(last.timestamp)
    if case .assistantText(let text, _, _) = last.event {
      hasher.combine(text.utf8.count)
      hasher.combine(text.hashValue)
    }
  }
  return hasher.finalize()
}

extension WorkSessionDestinationView: Equatable {
  static func == (lhs: WorkSessionDestinationView, rhs: WorkSessionDestinationView) -> Bool {
    lhs.sessionId == rhs.sessionId
      && lhs.initialOpeningPrompt == rhs.initialOpeningPrompt
      && lhs.initialSession == rhs.initialSession
      && lhs.initialChatSummary == rhs.initialChatSummary
      && workInitialTranscriptSeedRenderSignature(lhs.initialTranscript) == workInitialTranscriptSeedRenderSignature(rhs.initialTranscript)
      && (lhs.transitionNamespace == nil) == (rhs.transitionNamespace == nil)
      && lhs.isLive == rhs.isLive
      && lhs.navigationChrome == rhs.navigationChrome
      && lhs.showsLaneActions == rhs.showsLaneActions
      && lhs.navigationTitleOverride == rhs.navigationTitleOverride
      && workLaneListRenderSignature(lhs.lanes) == workLaneListRenderSignature(rhs.lanes)
      && lhs.crossProjectContext == rhs.crossProjectContext
  }
}

func workSubagentTranscriptToEnvelopes(
  messages: [SyncService.AgentChatSubagentTranscriptMessage],
  sessionId parentSessionId: String
) -> [WorkChatEnvelope] {
  let baseDate = Date(timeIntervalSince1970: 0)
  let coalesced = workCoalescedSubagentTranscriptMessages(messages)
  return coalesced.enumerated().compactMap { index, message in
    let text = workSubagentTranscriptText(message)
    let timestamp = workSubagentTranscriptIsoFormatter.string(from: baseDate.addingTimeInterval(Double(index)))
    let itemId = workSubagentTranscriptItemId(message)
    let event: WorkChatEvent
    switch message.type.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
    case "user":
      event = .userMessage(
        text: text,
        attachments: nil,
        turnId: nil,
        steerId: nil,
        deliveryState: nil,
        processed: true
      )
    case "assistant":
      event = .assistantText(
        text: text,
        turnId: nil,
        itemId: itemId?.isEmpty == false ? itemId : nil
      )
    default:
      event = .systemNotice(
        kind: "subagent",
        message: text.isEmpty ? "Subagent event" : text,
        detail: nil,
        turnId: nil,
        steerId: nil
      )
    }
    return WorkChatEnvelope(
      sessionId: "\(parentSessionId):subagent:\(message.sessionId)",
      timestamp: timestamp,
      sequence: index,
      event: event
    )
  }
}

func workSubagentTranscriptHasVisibleTimeline(_ envelopes: [WorkChatEnvelope]) -> Bool {
  guard !envelopes.isEmpty else { return false }
  return !buildWorkChatTimelineSnapshot(
    transcript: envelopes,
    fallbackEntries: [],
    artifacts: [],
    localEchoMessages: []
  ).timeline.isEmpty
}

private func workCoalescedSubagentTranscriptMessages(
  _ messages: [SyncService.AgentChatSubagentTranscriptMessage]
) -> [SyncService.AgentChatSubagentTranscriptMessage] {
  var result: [SyncService.AgentChatSubagentTranscriptMessage] = []
  result.reserveCapacity(messages.count)

  for message in messages {
    let key = workSubagentTranscriptMergeKey(message)
    if key != nil,
       let last = result.last,
       workSubagentTranscriptMergeKey(last) == key {
      var merged = last
      merged.text = workSubagentTranscriptRawText(last) + workSubagentTranscriptRawText(message)
      result[result.count - 1] = merged
      continue
    }
    result.append(message)
  }

  return result
}

private func workSubagentTranscriptMergeKey(_ message: SyncService.AgentChatSubagentTranscriptMessage) -> String? {
  let type = message.type.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  guard type == "assistant" || type == "user" else { return nil }
  guard let itemId = workSubagentTranscriptItemId(message), !itemId.isEmpty else { return nil }
  return "\(type)|\(message.sessionId)|\(itemId)"
}

private func workSubagentTranscriptItemId(_ message: SyncService.AgentChatSubagentTranscriptMessage) -> String? {
  let candidates = [
    workRemoteJSONString(message.message, key: "messageId"),
    workRemoteJSONString(message.message, key: "itemId"),
    message.uuid,
  ]
  return candidates
    .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
    .first { !$0.isEmpty }
}

private func workRemoteJSONString(_ value: RemoteJSONValue?, key: String) -> String? {
  guard case .object(let object)? = value,
        case .string(let string)? = object[key]
  else {
    return nil
  }
  return string
}

private func workSubagentTranscriptRawText(_ message: SyncService.AgentChatSubagentTranscriptMessage) -> String {
  if let text = message.text {
    return text
  }
  if let payload = message.message {
    return prettyPrintedRemoteJSONValue(payload)
  }
  return ""
}

private func workSubagentTranscriptText(_ message: SyncService.AgentChatSubagentTranscriptMessage) -> String {
  if let text = message.text?.trimmingCharacters(in: .whitespacesAndNewlines),
     !text.isEmpty {
    return text
  }
  if let payload = message.message {
    let text = prettyPrintedRemoteJSONValue(payload).trimmingCharacters(in: .whitespacesAndNewlines)
    if !text.isEmpty { return text }
  }
  return ""
}

private let workSubagentTranscriptIsoFormatter: ISO8601DateFormatter = {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter
}()

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
