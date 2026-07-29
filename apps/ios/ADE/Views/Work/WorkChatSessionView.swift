import SwiftUI
import UIKit
import AVKit

let workChatScrollCoordinateSpace = "WorkChatScrollCoordinateSpace"
let workChatStickThreshold: CGFloat = 160
let workChatStickResumeThreshold: CGFloat = 48
let workChatTouchScrollDeadband: CGFloat = 2
let workChatBottomAnchorSpacerHeight: CGFloat = 1
let workChatContentBottomGutterHeight: CGFloat = 2
let workChatSubagentActivePopupHeight: CGFloat = 34
let workChatOlderHistoryTriggerDistance: CGFloat = 240
let workChatOlderHistoryRearmDistance: CGFloat = 420
let workChatOlderHistoryScrollableDistance: CGFloat = 1

struct WorkChatOlderHistoryLoadResult {
  let succeeded: Bool
  let hasMoreHistory: Bool
  let addedTimelineEntries: Bool

  static let failed = WorkChatOlderHistoryLoadResult(
    succeeded: false,
    hasMoreHistory: false,
    addedTimelineEntries: false
  )

  static func loaded(hasMoreHistory: Bool, addedTimelineEntries: Bool) -> Self {
    WorkChatOlderHistoryLoadResult(
      succeeded: true,
      hasMoreHistory: hasMoreHistory,
      addedTimelineEntries: addedTimelineEntries
    )
  }
}

/// Why the chat timeline is empty. `timeline.isEmpty` alone cannot tell a
/// genuinely empty chat from one whose transcript request is still in flight
/// or was dropped, and rendering "No chat messages yet" for the latter two is
/// a false negative the user cannot distinguish from data loss.
enum WorkChatTranscriptLoadState: Equatable {
  case idle
  case loading
  case failed(String)
}

/// Copy for a failed transcript load. A transport error can arrive empty or as
/// whitespace; falling back keeps the failure state from reading like a blank
/// card, which is the exact ambiguity this state exists to remove.
func workChatTranscriptFailureMessage(_ message: String) -> String {
  let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else {
    return "The machine didn’t answer the transcript request."
  }
  return trimmed
}

func workChatShouldRequestOlderHistory(
  topY: CGFloat,
  triggerArmed: Bool,
  loading: Bool,
  hasError: Bool,
  hasBufferedEntries: Bool,
  hasHostHistory: Bool
) -> Bool {
  topY >= -workChatOlderHistoryTriggerDistance
    && triggerArmed
    && !loading
    && !hasError
    && (hasBufferedEntries || hasHostHistory)
}

func workChatShouldContinueAutomaticOlderHistory(
  distanceFromBottom: CGFloat,
  loading: Bool,
  hasError: Bool,
  hasBufferedEntries: Bool,
  hasHostHistory: Bool
) -> Bool {
  distanceFromBottom <= workChatOlderHistoryScrollableDistance
    && !loading
    && !hasError
    && (hasBufferedEntries || hasHostHistory)
}

final class WorkChatScrollMetrics {
  var distanceFromBottom: CGFloat = 0
}

struct WorkChatSummaryRenderContext: Equatable {
  let isAvailable: Bool
  let provider: String
  let model: String
  let modelId: String?
  let reasoningEffort: String
  let effectiveFastMode: Bool
  let runtimeMode: String
  let fastModeSupported: Bool
  let idleSinceAt: String?
  let endedAt: String?
  let lastOutputPreview: String?
  let requestedCwd: String?
  let modelLabel: String
  let contextWindowFallback: Int?
  let claudeGoal: AgentChatClaudeGoal?

  init(_ summary: AgentChatSessionSummary?) {
    guard let summary else {
      self.isAvailable = false
      self.provider = ""
      self.model = ""
      self.modelId = nil
      self.reasoningEffort = ""
      self.effectiveFastMode = false
      self.runtimeMode = ""
      self.fastModeSupported = false
      self.idleSinceAt = nil
      self.endedAt = nil
      self.lastOutputPreview = nil
      self.requestedCwd = nil
      self.modelLabel = "Model"
      self.contextWindowFallback = nil
      self.claudeGoal = nil
      return
    }

    self.isAvailable = true
    self.provider = summary.provider
    self.model = summary.model
    self.modelId = summary.modelId
    self.reasoningEffort = summary.reasoningEffort ?? ""
    self.effectiveFastMode = summary.effectiveFastMode
    self.runtimeMode = workInitialRuntimeMode(summary)
    self.fastModeSupported = workChatComposerSupportsFastMode(summary)
    self.idleSinceAt = summary.idleSinceAt
    self.endedAt = summary.endedAt
    self.lastOutputPreview = summary.lastOutputPreview
    self.requestedCwd = summary.requestedCwd
    self.modelLabel = prettyWorkChatModelName(summary.model)
    self.contextWindowFallback = workContextWindowFallback(modelId: summary.modelId, model: summary.model)
    self.claudeGoal = summary.claudeGoal
  }

  var currentModelId: String {
    modelId ?? model
  }
}

struct WorkChatSessionRenderContext: Equatable {
  let id: String
  let laneId: String
  let chatIdleSinceAt: String?
  let endedAt: String?
  let lastOutputPreview: String?
  let normalizedStatus: String

  init(_ session: TerminalSessionSummary) {
    self.id = session.id
    self.laneId = session.laneId
    self.chatIdleSinceAt = session.chatIdleSinceAt
    self.endedAt = session.endedAt
    self.lastOutputPreview = session.lastOutputPreview
    self.normalizedStatus = normalizedWorkChatSessionStatus(session: session, summary: nil)
  }
}

private struct WorkChatSummaryTimelineKey: Equatable {
  let provider: String
  let model: String
  let modelId: String?

  init(_ context: WorkChatSummaryRenderContext) {
    self.provider = context.provider
    self.model = context.model
    self.modelId = context.modelId
  }
}

struct WorkChatSessionView: View {
  @Environment(\.accessibilityReduceMotion) var reduceMotion

  let session: WorkChatSessionRenderContext
  let chatSummaryContext: WorkChatSummaryRenderContext
  let transcript: [WorkChatEnvelope]
  let transcriptRenderSignature: Int
  let fallbackEntries: [AgentChatTranscriptEntry]
  let fallbackEntriesRenderSignature: Int
  let artifacts: [ComputerUseArtifactSummary]
  let artifactsRenderSignature: Int
  let optimisticPendingSteers: [WorkPendingSteerModel]
  let optimisticPendingSteersRenderSignature: Int
  let localEchoMessages: [WorkLocalEchoMessage]
  let localEchoMessagesRenderSignature: Int
  let expandedToolCardIdsSnapshot: Set<String>
  let expandedToolCardIdsRenderSignature: Int
  let artifactContentRenderSignature: Int
  let artifactDrawerPresentedSnapshot: Bool
  let sendingSnapshot: Bool
  let errorMessageSnapshot: String?
  @Binding var expandedToolCardIds: Set<String>
  @Binding var artifactContent: [String: WorkLoadedArtifactContent]
  @Binding var fullscreenImage: WorkFullscreenImage?
  @Binding var artifactDrawerPresented: Bool
  let artifactRefreshInFlight: Bool
  let artifactRefreshError: String?
  @Binding var sending: Bool
  @Binding var errorMessage: String?
  @State var visibleTimelineCount = workTimelinePageSize
  @State var actionInFlight = false
  @State var isNearBottom = true
  @State var unreadBelowCount = 0
  @State var lastTimelineTailId: String?
  @State var scrollViewportHeight: CGFloat = 0
  @State var scrollViewportWidth: CGFloat = 0
  @State var composerLayoutHeight: CGFloat = 150
  @State var scrollMetrics = WorkChatScrollMetrics()
  @State var timelineDragActive = false
  @State var bottomStickinessReleasedByUser = false
  @State var timelineSnapshot = WorkChatTimelineSnapshot.empty
  @State var timelinePresentation = WorkTimelinePresentation.empty
  @State var turnToolActivity = WorkTurnToolActivityIndex(completedByTurnId: [:], active: nil)
  @State var timelineIncrementalCache = WorkTimelineIncrementalCache()
  @State var timelineSourceKey: String?
  @State var timelineRebuildTask: Task<Void, Never>?
  @State var timelineRebuildPending = false
  @State var timelineRebuildGeneration = 0
  @State var timelineBuildScopeId = UUID().uuidString
  @State var latestPinTask: Task<Void, Never>?
  @State var latestPinGeneration = 0
  @State var assistantPreviewCache = WorkAssistantPreviewCache()
  @State private var contextUsageViewModelCache = WorkContextUsageViewModelCache()
  @State var assistantLineBudgets: [String: Int] = [:]
  @State var composerSettingMutationInFlight = false
  @State var composerSettingMutationGeneration = 0
  @State var pendingCodexFastMode: Bool?
  @State var scrollStateSessionId: String?
  @State var pendingInitialBottomPinSessionId: String?
  @State var timelineLayoutPinToken = 0
  @State var olderHistoryLoadInFlight = false
  @State var olderHistoryLoadError: String?
  @State var olderHistoryTriggerArmed = true
  @State var olderHistoryAutomaticContinuationPending = false
  @State var olderHistoryLoadTask: Task<Void, Never>?
  let isLive: Bool
  let hostUnreachable: Bool
  let canComposeMessages: Bool
  let canSendMessages: Bool
  let sendWillQueue: Bool
  let sendWillQueueIsReconnect: Bool
  let activeSendModesAvailable: Bool
  let queueAwareStopAvailable: Bool
  let transportHealth: SyncTransportHealth
  let composerDraftRestore: WorkChatComposerDraftRestore?
  var inputLockMessage: String? = nil
  let transitionNamespace: Namespace.ID?
  let onOpenLane: (() -> Void)?
  let onSend: @MainActor (String, [WorkChatInputAttachment], WorkActiveSendMode) async -> Bool
  let onInterrupt: @MainActor (AgentChatStopMode) async -> Void
  let onRestoreCancelledQueue: (@MainActor (String) async -> Void)?
  let onApproveRequest: @MainActor (String, AgentChatApprovalDecision, String?) async -> Void
  let onRespondToQuestion: @MainActor (String, String, AgentChatInputAnswerValue?, String?) async -> Void
  let onSubmitQuestionAnswers: @MainActor (String, [String: AgentChatInputAnswerValue], String?) async -> Void
  let onDeclineQuestion: @MainActor (String) async -> Void
  let onRespondToPermission: @MainActor (String, AgentChatApprovalDecision) async -> Void
  let onRetryLoad: @MainActor () async -> Void
  let onOpenFile: @MainActor (String) async -> Void
  let onOpenPr: @MainActor (Int) async -> Void
  let onLoadArtifact: @MainActor (ComputerUseArtifactSummary) async -> Void
  let onRefreshArtifacts: @MainActor () async -> Void
  let onCancelSteer: @MainActor (String) async -> Void
  let onEditSteer: @MainActor (String, String) async -> Void
  let onDispatchSteerInline: (@MainActor (String) async -> Void)?
  let onDispatchSteerInterrupt: (@MainActor (String) async -> Void)?
  let onSelectModel: @MainActor (String) async -> Void
  let onSelectRuntimeMode: @MainActor (String) async -> Bool
  let onSelectEffort: @MainActor (String) async -> Void
  let onSelectCodexFastMode: @MainActor (Bool) async -> Bool

  var resolvedSessionStatus: String? = nil
  var lanes: [LaneSummary] = []
  var lanesRenderSignature: Int = 0
  // Host-side scroll-back: true while older transcript pages remain on the
  // host beyond what the phone has fetched; the callback pulls the next page.
  var hasOlderTranscriptHistory: Bool = false
  var onLoadOlderTranscript: (@MainActor () async -> WorkChatOlderHistoryLoadResult)? = nil
  var subagentSnapshots: [WorkSubagentSnapshot] = []
  var subagentSnapshotsRenderSignature: Int = 0
  var scheduledWorkSnapshots: [WorkScheduledWorkSnapshot] = []
  var scheduledWorkSnapshotsRenderSignature: Int = 0
  var selectedSubagentTaskId: String? = nil
  var onOpenChatInfo: (() -> Void)? = nil
  var onOpenSubagents: (() -> Void)? = nil
  /// Tapping a subagent spawn/result timeline row opens the same detail surface
  /// the Chat Info roster row opens (full transcript takeover or expanded row).
  var onSelectSubagentRow: (@MainActor (WorkSubagentSnapshot) async -> Void)? = nil
  var prBadge: WorkChatPrBadgeModel? = nil
  var onOpenPrDetails: (() -> Void)? = nil
  /// Live "turn is running" signal from the sync layer (chat_subscribe ack +
  /// live status/done events). Covers the gap where the synced session row
  /// still says idle while chat events are already streaming — without it
  /// the chat renders output with no stop button or working indicator.
  var liveTurnActiveHint: Bool? = nil
  var compactComposer = false
  var isPersonalChat: Bool = false
  var attachmentsAvailable: Bool = true
  var personalModelCatalogAvailable: Bool = true
  var personalSessionUpdatesAvailable: Bool = true
  /// Present only when the paired host advertises provider-neutral
  /// `chat.recoverTurn` or the legacy Codex-specific recovery action.
  /// Keeping this optional prevents a new phone build from offering controls
  /// that an older ADE brain cannot execute.
  var onRecoverCodexTurn: (@MainActor (String, String, String) async throws -> String)? = nil
  var onRunUnprocessedMessage: (@MainActor (WorkChatMessage) async throws -> Void)? = nil
  var onEditUnprocessedMessage: (@MainActor (WorkChatMessage) async throws -> Void)? = nil
  var onDismissUnprocessedMessage: (@MainActor (WorkChatMessage) async throws -> Void)? = nil
  /// Whether the transcript this chat is showing has actually arrived. An empty
  /// timeline is the same shape for a brand-new chat, a transcript request still
  /// in flight, and a `chat_subscribe` that was dropped and will never be
  /// answered — only this tells the empty state which of the three it is.
  /// Defaults to `.idle` so callers that have not wired a real load state keep
  /// today's behaviour instead of silently claiming a chat is loading.
  var transcriptLoadState: WorkChatTranscriptLoadState = .idle
  /// Re-requests the transcript after a failed load. When nil the failure state
  /// renders without a Retry button rather than offering a dead control.
  var onRetryTranscript: (() -> Void)? = nil

  @State var steerEditDrafts: [String: String] = [:]
  @State var modelPickerPresented = false
  @State var toolActivitySheet: WorkToolActivitySheetSelection?
  @State var modelUpdateInFlight = false
  /// Bumped each time a NEW blocking pending input arrives so the body can fire
  /// a single light haptic — keeps a question/plan gate from being missed.
  @State var blockingPendingHapticToken = 0
  /// Last blocking pending-input id we reacted to, so re-renders that keep the
  /// same gate open don't re-fire the haptic or re-scroll.
  @State var lastBlockingPendingInputId: String?
  /// Item ids of pending inputs the user just answered. They are hidden from the
  /// consolidated strip immediately (optimistic removal) so it advances to the
  /// next request without waiting for the host, and reconciled back out once the
  /// item leaves the derived queue (or rolled back if the command errored). See
  /// `dispatchPendingInputAnswer` / `reconcileOptimisticallyAnsweredInputs`.
  @State var optimisticallyAnsweredInputIds: Set<String> = []
  /// Id of the pending input the user minimized, if any.
  ///
  /// Derived, not synchronized: a minimize applies to the gate the user chose to
  /// defer, so it has to expire on its own the moment a different gate becomes
  /// primary. Storing the id and computing the Bool from it makes that
  /// impossible to get wrong; a Bool reset from an observer would be one more
  /// thing that can fall out of step and leave a fresh question hidden.
  @State var collapsedPendingInputId: String?

  var sessionStatus: String {
    resolvedSessionStatus ?? session.normalizedStatus
  }

  private var chatSummaryTimelineKey: WorkChatSummaryTimelineKey {
    WorkChatSummaryTimelineKey(chatSummaryContext)
  }

  /// Terminal transcript signal from the local event window. When present, it
  /// beats stale session rows / subscribe hints that can lag a just-finished
  /// turn by a few seconds.
  var transcriptLatestTurnEnded: Bool {
    timelineSnapshot.transcriptLatestTurnEnded
  }

  /// The live turn hint can be stale if mobile misses the final `done` event.
  /// When the synced row has an idle/end timestamp newer than our transcript
  /// tail, prefer the row so the working indicator clears promptly.
  var sessionRowEndedAfterLatestTranscript: Bool {
    guard sessionStatus == "idle" || sessionStatus == "ended" else { return false }
    let rowEndedAt = [
      chatSummaryContext.idleSinceAt,
      chatSummaryContext.endedAt,
      session.chatIdleSinceAt,
      session.endedAt
    ]
    .compactMap { value in
      value?.isEmpty == false ? value : nil
    }
    .max()
    guard let rowEndedAt else { return false }
    guard let latestTranscriptAt = timelineSnapshot.latestTranscriptTimestamp else { return false }
    if rowEndedAt >= latestTranscriptAt {
      return true
    }
    guard let rowEndedDate = workParsedDate(rowEndedAt),
          let latestTranscriptDate = workParsedDate(latestTranscriptAt) else {
      return false
    }
    return rowEndedDate >= latestTranscriptDate.addingTimeInterval(-0.25)
  }

  /// Single source of truth for "the assistant is generating right now".
  /// Drives the activity indicator, the composer stop button, and the
  /// streaming-markdown fast path.
  var isStreamingTurn: Bool {
    workChatIsStreaming(
      sessionStatus: sessionStatus,
      isLive: isLive,
      transcriptIndicatesActiveTurn: timelineSnapshot.transcriptIndicatesActiveTurn,
      liveTurnActiveHint: liveTurnActiveHint,
      transcriptLatestTurnEnded: transcriptLatestTurnEnded,
      rowEndedAfterLatestTranscript: sessionRowEndedAfterLatestTranscript
    )
  }

  var shouldShowInterruptControl: Bool {
    isStreamingTurn && timelineSnapshot.transcriptHasInterruptibleActivity
  }

  /// Canonical open pending inputs minus the ones the user just answered.
  /// `optimisticallyAnsweredInputIds` hides an item the instant a decision is
  /// dispatched so the consolidated strip advances to the next request without
  /// waiting for the host round-trip (iOS had no optimistic removal before, so
  /// the card visibly flickered). Entries are reconciled back out once the item
  /// leaves the derived queue, or rolled back if the command errored.
  var pendingInputs: [WorkPendingInputItem] {
    guard !optimisticallyAnsweredInputIds.isEmpty else {
      return timelineSnapshot.pendingInputs
    }
    return timelineSnapshot.pendingInputs.filter {
      !optimisticallyAnsweredInputIds.contains($0.itemId)
    }
  }

  /// Number of still-open requests in the consolidated strip; drives the
  /// "Request 1 of N" header and whether "Accept all" is offered.
  var pendingInputCount: Int {
    pendingInputs.count
  }

  /// Order-sensitive fingerprint of the CANONICAL (host-derived) pending queue,
  /// ignoring optimistic hides. Changes only when the host adds/removes/reorders
  /// a request, which is exactly when `reconcileOptimisticallyAnsweredInputs`
  /// should prune resolved optimistic entries.
  var canonicalPendingInputSignature: String {
    timelineSnapshot.pendingInputs.map(\.itemId).joined(separator: "\u{1F}")
  }

  var pendingSteers: [WorkPendingSteerModel] {
    mergeWorkPendingSteers(
      optimistic: optimisticPendingSteers,
      canonical: timelineSnapshot.pendingSteers
    )
  }

  var primaryPendingInput: WorkPendingInputItem? {
    pendingInputs.first
  }

  /// The strip is minimized only while the deferred gate is still the primary
  /// one. The gate stays open and the composer stays locked either way — only
  /// the card is swapped for a one-line pill.
  var pendingInputCollapsed: Bool {
    get {
      guard let collapsedPendingInputId, let primaryPendingInput else { return false }
      return collapsedPendingInputId == primaryPendingInput.id
    }
    nonmutating set {
      collapsedPendingInputId = newValue ? primaryPendingInput?.id : nil
    }
  }

  /// Total height available to the chat surface, keyboard already subtracted.
  ///
  /// The transcript and the composer inset split the surface between them, so
  /// their measured heights always sum back to it — and unlike either half on
  /// its own, the sum does NOT move when the pending-input card grows. That
  /// matters: sizing the card off `scrollViewportHeight` alone (what this used
  /// to do) was self-referential, because a taller card shrank the transcript,
  /// which shrank the budget, which... The floor is the 240 the transcript
  /// reports before its first real measurement.
  var chatSurfaceHeight: CGFloat {
    max(240, scrollViewportHeight + composerLayoutHeight)
  }

  var pendingInputMaxHeight: CGFloat {
    workPendingInputMaxHeight(chatSurfaceHeight: chatSurfaceHeight)
  }

  /// Open approval / permission gates that "Accept all" can sweep. Question,
  /// plan-approval, and model-selection kinds are never auto-answered.
  var acceptAllSweepableInputs: [WorkPendingInputItem] {
    pendingInputs.filter { item in
      switch item {
      case .approval, .permission: return true
      case .question, .planApproval, .modelSelection: return false
      }
    }
  }

  /// "Accept all" is only offered when more than one request is queued and the
  /// current (primary) request is itself an approval/permission gate — matching
  /// desktop, where accepting-all flips session auto-approve for the current
  /// item then accepts the remaining approval/permission requests.
  var canAcceptAllPendingInputs: Bool {
    guard pendingInputCount > 1, let primary = primaryPendingInput else { return false }
    switch primary {
    case .approval, .permission:
      return acceptAllSweepableInputs.count > 1
    case .question, .planApproval, .modelSelection:
      return false
    }
  }

  var hasPendingInputGate: Bool {
    workChatComposerBlocksFreeformInput(pendingInputCount: pendingInputs.count, sessionStatus: sessionStatus)
  }

  var composerPlaceholderText: String {
    workChatComposerPlaceholder(pendingInputs: pendingInputs, sessionStatus: sessionStatus)
  }

  /// Stable id of the first blocking pending input awaiting a reply, or nil when
  /// none is open. Drives the arrival haptic + elevate-into-view so a blocking
  /// question/plan gate can't be silently missed. Only fires when the session is
  /// live (an offline read-only card isn't actionable, so no haptic).
  var blockingPendingInputId: String? {
    guard isLive else { return nil }
    return primaryPendingInput?.id
  }

  /// React to a newly-arrived blocking pending input: fire one light haptic.
  /// All pending inputs now render in the consolidated strip pinned above the
  /// composer, so none require a transcript scroll. No-ops when the same gate is
  /// already open.
  @MainActor
  func handleBlockingPendingInputChange(_ id: String?) {
    guard id != lastBlockingPendingInputId else { return }
    lastBlockingPendingInputId = id
    guard id != nil else { return }
    blockingPendingHapticToken &+= 1
  }

  @MainActor
  private func runComposerSettingMutation(
    onFailure: @MainActor @escaping () -> Void = {},
    operation: @MainActor @escaping () async -> Bool
  ) {
    let generation = composerSettingMutationGeneration + 1
    composerSettingMutationGeneration = generation
    composerSettingMutationInFlight = true

    Task { @MainActor in
      let succeeded = await operation()
      guard generation == composerSettingMutationGeneration else { return }
      composerSettingMutationInFlight = false
      if !succeeded {
        onFailure()
      }
    }
  }

  var toolCards: [WorkToolCardModel] {
    timelineSnapshot.toolCards
  }

  var eventCards: [WorkEventCardModel] {
    timelineSnapshot.eventCards
  }

  var commandCards: [WorkCommandCardModel] {
    timelineSnapshot.commandCards
  }

  var fileChangeCards: [WorkFileChangeCardModel] {
    timelineSnapshot.fileChangeCards
  }

  var timeline: [WorkTimelineEntry] {
    timelineSnapshot.timeline
  }

  var visibleTimeline: [WorkTimelineEntry] {
    timelinePresentation.visibleEntries
  }

  var visibleTimelineRenderEntries: [WorkTimelineRenderEntry] {
    timelinePresentation.renderEntries
  }

  var latestScrollTargetId: String {
    // The bottom sentinel is the same view used for scroll metrics. Pinning to a
    // markdown block or streaming row can leave the sentinel below the viewport,
    // which looks like a blank tail and keeps the Latest pill stale.
    "chat-end"
  }

  var hiddenTimelineCount: Int {
    timelinePresentation.hiddenCount
  }

  var canRequestOlderTranscriptHistory: Bool {
    hasOlderTranscriptHistory && onLoadOlderTranscript != nil
  }

  @MainActor
  func refreshTimelinePresentation(sourceTimeline: [WorkTimelineEntry]? = nil) {
    let timeline = sourceTimeline ?? timelineSnapshot.timeline
    turnToolActivity = workTurnToolActivityIndex(from: timeline)
    let presentedTimeline = timeline.filter { entry in
      if case .toolGroup = entry.payload { return false }
      return true
    }
    var nextPresentation = makeWorkTimelinePresentation(
      timeline: presentedTimeline,
      visibleCount: visibleTimelineCount,
      chatSummary: chatSummaryContext,
      transcript: transcript,
      assistantPreviewCache: assistantPreviewCache,
      assistantLineBudgets: assistantLineBudgets,
      streamingAssistantMessageId: streamingAssistantMessageId
    )
    let timelineDelta = nextPresentation.timelineCount - timelinePresentation.timelineCount
    let prependedHistory = (
      timelineDelta > 0
      && timelinePresentation.timelineFirstId != nil
      && timelinePresentation.timelineLastId != nil
      && timelinePresentation.timelineLastId == nextPresentation.timelineLastId
      && timelinePresentation.timelineFirstId != nextPresentation.timelineFirstId
    )
    if prependedHistory {
      visibleTimelineCount = workTimelineVisibleCountAfterHistoryPrepend(
        currentVisibleCount: visibleTimelineCount,
        prependedCount: timelineDelta
      )
      nextPresentation = makeWorkTimelinePresentation(
        timeline: presentedTimeline,
        visibleCount: visibleTimelineCount,
        chatSummary: chatSummaryContext,
        transcript: transcript,
        assistantPreviewCache: assistantPreviewCache,
        assistantLineBudgets: assistantLineBudgets,
        streamingAssistantMessageId: streamingAssistantMessageId
      )
    }
    guard nextPresentation != timelinePresentation else { return }
    timelinePresentation = nextPresentation
  }

  var canCompose: Bool {
    // Typing stays available so users can draft while disconnected or while
    // a turn is running, except when a blocking pending-input card is open —
    // those replies must go through the structured card the runtime is awaiting.
    canComposeMessages && !hasPendingInputGate
  }

  var canSend: Bool {
    // Existing chats accept messages while live, and can still accept them
    // during reconnects when desktop advertised chat.send as queueable. Pending
    // input is gated separately so the host receives a structured answer.
    canSendMessages && (!sending || sendWillQueue) && !hasPendingInputGate
  }

  var composerFeedback: String? {
    if let inputLockMessage {
      return inputLockMessage
    }
    if sending && !sendWillQueue {
      return "Sending message to machine..."
    }
    if sendWillQueueIsReconnect, pendingSteers.isEmpty {
      return "Machine is reconnecting. Send will queue until it is back."
    }
    if transportHealth == .connecting {
      return "Reconnecting… Your draft is safe."
    }
    if !canSendMessages {
      return "Waiting for the machine before sending."
    }
    if pendingInputs.count == 1 {
      // The single request renders in the consolidated strip directly above the
      // composer with its own actions, so it carries no guidance banner.
      return nil
    }
    if !pendingInputs.isEmpty {
      // Multiple queued requests: the strip shows "Request 1 of N" and advances
      // as each is answered, so point the user at it.
      return "Answer the waiting prompt above, or decline it before sending another message."
    }
    return nil
  }

  var jumpToLatestPillBottomPadding: CGFloat {
    16
  }

  var maxUserBubbleWidth: CGFloat? {
    guard scrollViewportWidth > 32 else { return nil }
    return (scrollViewportWidth - 32) * 0.92
  }

  @ViewBuilder
  var sessionOverviewSection: some View {
    // When live, approval_request cards (tool approval gates) render at the
    // top — structured questions, permission gates, and plan approvals get
    // their inline treatment in the timeline instead.
    //
    // When offline, we no longer stack "Reconnect to respond" banners here.
    // The top-right ADEConnectionDot already signals "Offline" and the
    // pending cards themselves stay visible in the timeline in a read-only
    // state, so duplicating the reconnect nag at the top added noise
    // without new information.
    // Tool/file-change approval gates now render as a pinned badge directly
    // above the composer (see `composerInset`), mirroring the plan-ready badge,
    // so the Accept / Decline actions are always in reach instead of scrolled
    // off the top of the transcript.

    // Connection-caused failures are communicated via the top-right gear, but
    // cached/offline chat actions still need their own visible errors.
    if let errorMessageSnapshot, !hostUnreachable {
      ADENoticeCard(
        title: "Chat error",
        message: errorMessageSnapshot,
        icon: "exclamationmark.triangle.fill",
        tint: ADEColor.danger,
        actionTitle: "Retry",
        action: { Task { await onRetryLoad() } }
      )
    }
  }

  @ViewBuilder
  func timelineSection(proxy: ScrollViewProxy) -> some View {
    if hiddenTimelineCount > 0 || canRequestOlderTranscriptHistory {
      Group {
        if olderHistoryLoadInFlight {
          HStack(spacing: 8) {
            ProgressView()
              .controlSize(.small)
            Text("Loading earlier messages…")
          }
          .frame(maxWidth: .infinity, minHeight: 28)
        } else if let olderHistoryLoadError {
          Button {
            requestEarlierTimelineEntries(
              automatically: olderHistoryAutomaticContinuationPending
            )
          } label: {
            Label("Couldn’t load earlier messages · Retry", systemImage: "arrow.clockwise")
              .frame(maxWidth: .infinity, minHeight: 44)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .foregroundStyle(ADEColor.accent)
          .accessibilityHint(olderHistoryLoadError)
        } else {
          Color.clear
            .frame(height: 1)
            .accessibilityHidden(true)
        }
      }
      .font(.footnote.weight(.semibold))
      .background(
        GeometryReader { geometry in
          Color.clear.preference(
            key: WorkChatContentTopPreferenceKey.self,
            value: geometry.frame(in: .named(workChatScrollCoordinateSpace)).minY
          )
        }
      )
    }

    if timeline.isEmpty {
      transcriptEmptyStateSection
    } else {
      let streamingMessageId = streamingAssistantMessageId
      let userBubbleWidth = maxUserBubbleWidth
      ForEach(visibleTimelineRenderEntries) { entry in
        timelineRenderEntryView(
          for: entry,
          proxy: proxy,
          streamingAssistantMessageId: streamingMessageId,
          maxUserBubbleWidth: userBubbleWidth
        )
      }
    }
  }

  /// What an empty timeline is allowed to claim.
  ///
  /// "No chat messages yet" is an assertion about the host's state, so it may
  /// only be shown once the transcript has actually been answered. While the
  /// request is in flight — or after it failed or was dropped — the pane says
  /// so instead, because a confident empty state there is indistinguishable
  /// from data loss to the person holding the phone.
  @ViewBuilder
  var transcriptEmptyStateSection: some View {
    switch transcriptLoadState {
    case .loading:
      VStack(spacing: 14) {
        ProgressView()
          .controlSize(.large)
          .tint(ADEColor.accent)
        Text("Loading transcript…")
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .multilineTextAlignment(.center)
      }
      .frame(maxWidth: .infinity)
      .adeGlassCard(cornerRadius: 20, padding: 24)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("Loading transcript")
      .accessibilityAddTraits(.updatesFrequently)
      .adeInspectable("Work.Chat.Transcript.Loading")
    case .failed(let message):
      ADEEmptyStateView(
        symbol: "exclamationmark.triangle",
        title: "Couldn’t load the transcript",
        message: workChatTranscriptFailureMessage(message)
      ) {
        if let onRetryTranscript {
          Button {
            onRetryTranscript()
          } label: {
            Label("Retry", systemImage: "arrow.clockwise")
              .font(.subheadline.weight(.semibold))
              .frame(minHeight: 44)
              .padding(.horizontal, 18)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .foregroundStyle(ADEColor.accent)
          .accessibilityLabel("Retry loading the transcript")
        }
      }
      .adeInspectable("Work.Chat.Transcript.LoadFailed")
    case .idle:
      ADEEmptyStateView(
        symbol: "bubble.left.and.bubble.right",
        title: selectedSubagentTaskId == nil ? "No chat messages yet" : "No subagent transcript",
        message: selectedSubagentTaskId == nil
          ? (isLive ? "Send a message to start streaming the transcript." : "Reconnect to load the latest chat history from the machine.")
          : "This subagent did not publish detailed transcript output."
      )
    }
  }

  @ViewBuilder
  var streamingStatusSection: some View {
    if isStreamingTurn {
      WorkActivityIndicator(
        transcript: transcript,
        isStreaming: true,
        toolCount: turnToolActivity.active?.count ?? 0,
        onOpenActivity: turnToolActivity.active.map { _ in
          { toolActivitySheet = .active }
        }
      )
      .id("chat-streaming-status")
      .frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
    }
  }

  /// Single desktop-shaped composer card: text field on top, chip strip and
  /// send button on the bottom, everything wrapped in one rounded container
  /// with clear contrast against the chat background.
  func composerInset(proxy: ScrollViewProxy) -> some View {
    VStack(spacing: 10) {
      // The redundant ENDED/RUNNING status pill row has been retired. Chat
      // lifecycle controls live outside the composer; this space is reserved
      // for pending input and send feedback.
      if let claudeGoal = workClaudeGoal(snapshot: chatSummaryContext.claudeGoal, transcript: transcript) {
        WorkClaudeGoalPill(goal: claudeGoal)
      }

      let subagentCount = subagentSnapshots.count
      let activeScheduledWorkCount = workScheduledWorkActiveCount(scheduledWorkSnapshots)
      let showsChatInfoBadge = inputLockMessage == nil && activeScheduledWorkCount > 0 && onOpenChatInfo != nil
      let showsSubagentBadge = inputLockMessage == nil && subagentCount > 0 && onOpenSubagents != nil
      let showsPrBadge = inputLockMessage == nil && prBadge != nil && onOpenPrDetails != nil
      if showsChatInfoBadge || showsSubagentBadge || showsPrBadge {
        HStack(spacing: 8) {
          if showsChatInfoBadge, let onOpenChatInfo {
            WorkChatInfoActivePopup(count: activeScheduledWorkCount, onOpen: onOpenChatInfo)
          }
          if showsSubagentBadge, let onOpenSubagents {
            WorkSubagentActivePopup(count: subagentCount, onOpen: onOpenSubagents)
          }
          if showsPrBadge, let prBadge, let onOpenPrDetails {
            WorkChatPrActivePopup(badge: prBadge, onOpen: onOpenPrDetails)
          }
          Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(height: workChatSubagentActivePopupHeight, alignment: .leading)
      }

      if !pendingSteers.isEmpty {
        WorkQueuedSteerStrip(
          steers: pendingSteers,
          drafts: $steerEditDrafts,
          busy: actionInFlight,
          isLive: isLive,
          onCancel: { steerId in
            await runSessionAction {
              await onCancelSteer(steerId)
              steerEditDrafts.removeValue(forKey: steerId)
            }
          },
          onSaveEdit: { steerId, text in
            await runSessionAction {
              await onEditSteer(steerId, text)
              steerEditDrafts.removeValue(forKey: steerId)
            }
          },
          onDispatchInline: onDispatchSteerInline.map { dispatch in
            { steerId in
              await runSessionAction {
                await dispatch(steerId)
                steerEditDrafts.removeValue(forKey: steerId)
                scrollToLatest(proxy, animated: true)
                unreadBelowCount = 0
              }
            }
          },
          onDispatchInterrupt: onDispatchSteerInterrupt.map { dispatch in
            { steerId in
              await runSessionAction {
                await dispatch(steerId)
                steerEditDrafts.removeValue(forKey: steerId)
                scrollToLatest(proxy, animated: true)
                unreadBelowCount = 0
              }
            }
          }
        )
      }

      if let composerFeedback {
        Text(composerFeedback)
          .font(.caption2)
          .foregroundStyle(sessionStatus == "awaiting-input" ? ADEColor.warning : ADEColor.textMuted)
          .frame(maxWidth: .infinity, alignment: .center)
          .padding(.horizontal, sessionStatus == "awaiting-input" ? 10 : 0)
          .padding(.vertical, sessionStatus == "awaiting-input" ? 7 : 0)
          .background(
            Group {
              if sessionStatus == "awaiting-input" {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                  .fill(ADEColor.warning.opacity(0.08))
              }
            }
          )
      }

      consolidatedPendingStripSection

      if let recovery = workAvailableQueueRecovery(from: transcript),
         let onRestoreCancelledQueue {
        WorkQueueRecoveryBanner(
          recovery: recovery,
          restoring: actionInFlight,
          enabled: !hostUnreachable && !actionInFlight,
          onRestore: {
            await runSessionAction {
              await onRestoreCancelledQueue(recovery.recoveryId)
            }
          }
        )
      }

      WorkChatComposerCard(
        chatSummary: chatSummaryContext,
        usageViewModel: contextUsageViewModelCache.value(
          sessionId: session.id,
          transcript: transcript,
          transcriptRenderSignature: transcriptRenderSignature,
          provider: chatSummaryContext.provider,
          fallbackContextWindow: chatSummaryContext.contextWindowFallback
        ),
        laneId: session.laneId,
        dictationTargetId: "work-chat:\(session.id)",
        awaitingInputGate: hasPendingInputGate,
        composerPlaceholder: composerPlaceholderText,
        canCompose: canCompose,
        canSend: canSend && !composerSettingMutationInFlight,
        attachmentsAvailable: attachmentsAvailable,
        canUploadAttachments: isLive && attachmentsAvailable,
        sending: sending && !sendWillQueue,
        settingsMutationInFlight: composerSettingMutationInFlight,
        codexFastModeOverride: pendingCodexFastMode,
        composerDraftRestore: composerDraftRestore,
        draftPersistenceKey: WorkComposerDraftStore.chatKey(sessionId: session.id),
        compact: compactComposer,
        // Show Stop while a live turn has current transcript activity. The
        // broader live hint can lag after `done`; this stricter gate keeps the
        // composer from showing Stop after the completed-turn separator appears.
        showInterrupt: shouldShowInterruptControl,
        activeSendModesAvailable: activeSendModesAvailable,
        queueAwareStopAvailable: queueAwareStopAvailable,
        interruptInFlight: actionInFlight,
        onInterrupt: { mode in
          await runSessionAction {
            await onInterrupt(mode)
          }
        },
        onOpenModelPicker: !chatSummaryContext.isAvailable
          || (isPersonalChat && (
            !personalModelCatalogAvailable || !personalSessionUpdatesAvailable
          ))
          ? nil
          : { modelPickerPresented = true },
        onSelectRuntimeMode: !chatSummaryContext.isAvailable
          || (isPersonalChat && !personalSessionUpdatesAvailable)
          ? nil
          : { mode in
          runComposerSettingMutation {
            await onSelectRuntimeMode(mode)
          }
        },
        onSend: onSend,
        onSent: {
          scrollToLatest(proxy, animated: true)
        }
      )
    }
    .padding(.horizontal, compactComposer ? 12 : 16)
    .padding(.top, 4)
    .padding(.bottom, 0)
  }

  var body: some View {
    ScrollViewReader { proxy in
      VStack(spacing: 0) {
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 14) {
            sessionOverviewSection
            timelineSection(proxy: proxy)
            streamingStatusSection

            Color.clear
              .frame(height: workChatContentBottomGutterHeight + workChatBottomAnchorSpacerHeight)
              .id("chat-end")
              .transaction { transaction in
                transaction.animation = nil
              }
              .background(
                GeometryReader { geometry in
                  Color.clear.preference(
                    key: WorkChatContentBottomPreferenceKey.self,
                    value: geometry.frame(in: .named(workChatScrollCoordinateSpace)).maxY
                  )
                }
              )
          }
          .padding(16)
          .frame(
            maxWidth: .infinity,
            minHeight: max(scrollViewportHeight, 0),
            alignment: .bottomLeading
          )
          .modifier(
            WorkChatTranscriptEnvironmentModifier(
              provider: chatSummaryContext.provider,
              modelId: chatSummaryContext.currentModelId,
              modelLabel: chatSummaryContext.modelLabel,
              laneId: session.laneId,
              requestedCwd: chatSummaryContext.requestedCwd,
              isPersonalChat: isPersonalChat
            )
          )
        }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .layoutPriority(1)
          .clipped()
          .scrollIndicators(.hidden)
          .scrollDismissesKeyboard(.interactively)
          .coordinateSpace(name: workChatScrollCoordinateSpace)
          .background(
            GeometryReader { geometry in
              Color.clear
                .preference(
                  key: WorkChatViewportHeightPreferenceKey.self,
                  value: geometry.size.height
                )
                .preference(
                  key: WorkChatViewportWidthPreferenceKey.self,
                  value: geometry.size.width
                )
            }
          )
          .simultaneousGesture(
            DragGesture(minimumDistance: 0)
              .onChanged { value in
                if !timelineDragActive {
                  timelineDragActive = true
                }
                if value.translation.height > workChatTouchScrollDeadband {
                  releaseBottomStickinessForUserScroll(reason: "drag")
                } else if value.translation.height < -workChatTouchScrollDeadband {
                  allowBottomStickinessResumeFromUserScroll(reason: "drag")
                }
              }
              .onEnded { value in
                let releasedBottomStickiness = value.translation.height > workChatTouchScrollDeadband
                if timelineDragActive {
                  timelineDragActive = false
                }
                guard !releasedBottomStickiness else { return }
                updateBottomStickiness(distanceFromBottom: scrollMetrics.distanceFromBottom, proxy: proxy)
              }
          )
          .overlay(alignment: .top) {
            WorkChatNavigationBackdrop()
          }
          .overlay(alignment: .bottomTrailing) {
            if unreadBelowCount > 0 || !isNearBottom {
              WorkJumpToLatestPill(count: unreadBelowCount) {
                isNearBottom = true
                if timelineDragActive {
                  timelineDragActive = false
                }
                scrollToLatest(proxy, animated: true)
                unreadBelowCount = 0
              }
              .padding(.trailing, 16)
              .padding(.bottom, jumpToLatestPillBottomPadding)
              .transition(.move(edge: .trailing).combined(with: .opacity))
            }
          }

        composerInset(proxy: proxy)
          .fixedSize(horizontal: false, vertical: true)
          .background(alignment: .bottom) {
            WorkChatComposerBackdrop()
          }
          .background(
            GeometryReader { geometry in
              Color.clear.preference(
                key: WorkChatComposerLayoutHeightPreferenceKey.self,
                value: geometry.size.height
              )
            }
          )
      }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(workChatCanvasBackground.ignoresSafeArea())
        .adeNavigationGlass()
        .onPreferenceChange(WorkChatViewportHeightPreferenceKey.self) { height in
          let changed = abs(scrollViewportHeight - height) > 1
          scrollViewportHeight = height
          guard changed, isNearBottom else { return }
          pinToLatestAfterLayout(proxy, reason: "viewport-height")
        }
        .onPreferenceChange(WorkChatViewportWidthPreferenceKey.self) { width in
          scrollViewportWidth = width
        }
        .onPreferenceChange(WorkChatComposerLayoutHeightPreferenceKey.self) { height in
          guard height > 0, abs(composerLayoutHeight - height) > 1 else { return }
          composerLayoutHeight = height
          guard isNearBottom else { return }
          pinToLatestAfterLayout(proxy, reason: "composer-height")
        }
        .onPreferenceChange(WorkChatContentBottomPreferenceKey.self) { bottomY in
          guard scrollViewportHeight > 1 else { return }
          updateBottomStickiness(
            distanceFromBottom: max(0, bottomY - scrollViewportHeight),
            proxy: proxy
          )
          continueAutomaticOlderHistoryIfNeeded()
          resolvePendingInitialBottomPinAfterLayout(proxy, reason: "content-bottom")
        }
        .onPreferenceChange(WorkChatContentTopPreferenceKey.self) { topY in
          if topY < -workChatOlderHistoryRearmDistance {
            olderHistoryTriggerArmed = true
          }
          guard workChatShouldRequestOlderHistory(
            topY: topY,
            triggerArmed: olderHistoryTriggerArmed,
            loading: olderHistoryLoadInFlight,
            hasError: olderHistoryLoadError != nil,
            hasBufferedEntries: hiddenTimelineCount > 0,
            hasHostHistory: canRequestOlderTranscriptHistory
          ) else { return }
          olderHistoryTriggerArmed = false
          requestEarlierTimelineEntries(automatically: true)
        }
        .onChange(of: timeline.count) { oldCount, newCount in
          let previousTailId = lastTimelineTailId
          lastTimelineTailId = timeline.last?.id
          let delta = newCount - oldCount
          guard delta > 0 else { return }
          // Older-page prepends grow the timeline above the viewport — the
          // newest entry stays put. Don't autoscroll to the bottom or flag
          // the prepended entries as "new messages below".
          if let previousTailId, previousTailId == timeline.last?.id {
            return
          }
          if isNearBottom {
            pinToLatestAfterLayout(proxy, reason: "timeline-growth")
          } else {
            let nextCount = unreadBelowCount + delta
            if unreadBelowCount == 0 {
              withAnimation(ADEMotion.standard(reduceMotion: reduceMotion)) {
                unreadBelowCount = nextCount
              }
            } else {
              unreadBelowCount = nextCount
            }
          }
        }
        .onChange(of: timeline.last?.id) { oldTailId, newTailId in
          guard oldTailId != newTailId else { return }
          lastTimelineTailId = newTailId
          guard oldTailId != nil, newTailId != nil, isNearBottom else { return }
          pinToLatestAfterLayout(proxy, reason: "timeline-tail")
        }
        .onChange(of: workSubagentRunningCount(subagentSnapshots)) { _, _ in
          guard isNearBottom else { return }
          pinToLatestAfterLayout(proxy, reason: "subagent-active-count")
        }
        .onChange(of: timelineLayoutPinToken) { _, _ in
          if pendingInitialBottomPinSessionId == session.id {
            forcePinToLatestAfterLayout(proxy, reason: "initial-timeline-layout")
          } else {
            pinToLatestAfterLayout(proxy, reason: "timeline-layout")
          }
        }
        .onChange(of: isNearBottom) { _, nearBottom in
          guard nearBottom, unreadBelowCount > 0 else { return }
          withAnimation(ADEMotion.quick(reduceMotion: reduceMotion)) {
            unreadBelowCount = 0
          }
        }
        .onAppear {
          prepareScrollStateForCurrentSessionIfNeeded(reason: "appear")
          if transcript.isEmpty && fallbackEntries.isEmpty {
            scheduleTimelineSnapshotRebuild()
          } else {
            rebuildTimelineSnapshot()
          }
          // Seed the blocking-input tracker so an already-open gate on first
          // render doesn't re-fire the haptic, but a gate that arrives later does.
          lastBlockingPendingInputId = blockingPendingInputId
        }
        .task(id: timelineInputRecoveryKey) {
          recoverEmptyTimelineSnapshotIfNeeded()
        }
        .onDisappear {
          olderHistoryLoadTask?.cancel()
          olderHistoryLoadTask = nil
          olderHistoryLoadInFlight = false
          olderHistoryLoadError = nil
          olderHistoryAutomaticContinuationPending = false
          olderHistoryTriggerArmed = true
          cancelScheduledTimelineSnapshotRebuild()
        }
        .onChange(of: chatSummaryTimelineKey) { _, _ in
          refreshTimelinePresentation()
        }
        .onChange(of: chatSummaryContext.effectiveFastMode) { _, newValue in
          if let pendingCodexFastMode, pendingCodexFastMode == newValue {
            self.pendingCodexFastMode = nil
          }
        }
        .onChange(of: session.id) { _, _ in
          pendingCodexFastMode = nil
          lastBlockingPendingInputId = nil
          blockingPendingHapticToken = 0
          optimisticallyAnsweredInputIds.removeAll()
          collapsedPendingInputId = nil
          assistantLineBudgets.removeAll()
          composerSettingMutationInFlight = false
          composerSettingMutationGeneration &+= 1
          resetScrollStateForCurrentSession(reason: "session-change")
          cancelScheduledTimelineSnapshotRebuild()
          timelineSnapshot = .empty
          timelinePresentation = .empty
          turnToolActivity = WorkTurnToolActivityIndex(completedByTurnId: [:], active: nil)
          toolActivitySheet = nil
          scheduleTimelineSnapshotRebuild()
        }
        .onChange(of: transcript) { _, _ in
          if timelineSnapshot.timeline.isEmpty, !transcript.isEmpty {
            cancelScheduledTimelineSnapshotRebuild()
            rebuildTimelineSnapshot()
          } else {
            scheduleTimelineSnapshotRebuild()
          }
        }
        .onChange(of: fallbackEntries) { _, _ in
          guard transcript.isEmpty else {
            return
          }
          if timelineSnapshot.timeline.isEmpty, !fallbackEntries.isEmpty {
            cancelScheduledTimelineSnapshotRebuild()
            rebuildTimelineSnapshot()
          } else {
            scheduleTimelineSnapshotRebuild()
          }
        }
        .onChange(of: artifacts) { _, _ in
          scheduleTimelineSnapshotRebuild()
        }
        .onChange(of: localEchoMessages) { _, _ in
          scheduleTimelineSnapshotRebuild()
        }
        .onChange(of: blockingPendingInputId) { _, newId in
          handleBlockingPendingInputChange(newId)
        }
        .sensoryFeedback(.impact(weight: .light), trigger: blockingPendingHapticToken)
        .sheet(isPresented: $artifactDrawerPresented) {
          WorkArtifactDrawerSheet(
            artifacts: artifacts,
            artifactContent: $artifactContent,
            isRefreshing: artifactRefreshInFlight,
            refreshError: artifactRefreshError,
            onRefresh: onRefreshArtifacts,
            onLoadArtifact: onLoadArtifact
          )
          .presentationDetents([.medium, .large])
          .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $modelPickerPresented) {
          let currentModelId = chatSummaryContext.currentModelId
          WorkModelPickerSheet(
            currentModelId: currentModelId,
            currentProvider: chatSummaryContext.provider,
            currentReasoningEffort: chatSummaryContext.reasoningEffort,
            currentCodexFastMode: chatSummaryContext.effectiveFastMode,
            lanes: lanes,
            commandScope: isPersonalChat ? .personal : .project,
            isBusy: modelUpdateInFlight,
            onSelect: { option, pickedReasoning, _, pickedFastMode in
              Task { @MainActor in
                modelUpdateInFlight = true
                defer { modelUpdateInFlight = false }
                let wasCurrentModel = workModelIdsEquivalent(option.id, currentModelId)
                if !wasCurrentModel {
                  await onSelectModel(option.id)
                }
                guard !Task.isCancelled else { return }
                let currentReasoning = chatSummaryContext.reasoningEffort
                let nextReasoning = pickedReasoning ?? ""
                if nextReasoning != currentReasoning {
                  await onSelectEffort(nextReasoning)
                }
                guard !Task.isCancelled else { return }
                if option.supportsCodexFastMode || chatSummaryContext.effectiveFastMode != pickedFastMode {
                  _ = await onSelectCodexFastMode(option.supportsCodexFastMode ? pickedFastMode : false)
                }
              }
            }
          )
        }
        .sheet(item: $toolActivitySheet) { selection in
          if let group = toolActivityGroup(for: selection) {
            WorkTurnActivitySheet(group: group)
              .presentationDetents([.medium, .large])
              .presentationDragIndicator(.visible)
          }
        }
      }
    }
}

private extension WorkChatSessionView {
  func toolActivityGroup(for selection: WorkToolActivitySheetSelection) -> WorkToolGroupModel? {
    switch selection {
    case .active:
      return turnToolActivity.active
    case .completed(let turnId):
      return turnToolActivity.completedByTurnId[turnId]
    }
  }
}

func workLoadedArtifactContentRenderSignature(_ content: [String: WorkLoadedArtifactContent]) -> Int {
  var hasher = Hasher()
  hasher.combine(content.count)
  for key in content.keys.sorted() {
    hasher.combine(key)
    guard let value = content[key] else { continue }
    switch value {
    case .image(let image):
      hasher.combine("image")
      hasher.combine(Int(image.size.width.rounded()))
      hasher.combine(Int(image.size.height.rounded()))
      hasher.combine(Int(image.scale.rounded()))
    case .video(let url):
      hasher.combine("video")
      hasher.combine(url.absoluteString)
    case .remoteURL(let url):
      hasher.combine("remoteURL")
      hasher.combine(url.absoluteString)
    case .text(let text):
      hasher.combine("text")
      hasher.combine(text.utf8.count)
      hasher.combine(text.hashValue)
    case .error(let message):
      hasher.combine("error")
      hasher.combine(message)
    }
  }
  return hasher.finalize()
}

func workChatEnvelopeListRenderSignature(_ transcript: [WorkChatEnvelope]) -> Int {
  var hasher = Hasher()
  hasher.combine(transcript.count)
  for envelope in transcript {
    hasher.combine(workChatEnvelopeMergeKey(envelope))
    hasher.combine(envelope.sequence)
    hasher.combine(envelope.timestamp)
    if case .assistantText(let text, _, _) = envelope.event {
      hasher.combine(text.utf8.count)
      hasher.combine(text.hashValue)
    }
  }
  return hasher.finalize()
}

func workFallbackEntriesRenderSignature(_ entries: [AgentChatTranscriptEntry]) -> Int {
  var hasher = Hasher()
  hasher.combine(entries.count)
  for entry in entries {
    hasher.combine(workTranscriptEntryIdentity(entry))
  }
  return hasher.finalize()
}

func workArtifactSummariesRenderSignature(_ artifacts: [ComputerUseArtifactSummary]) -> Int {
  var hasher = Hasher()
  hasher.combine(artifacts.count)
  for artifact in artifacts {
    hasher.combine(artifact.id)
    hasher.combine(artifact.uri)
    hasher.combine(artifact.title)
    hasher.combine(artifact.reviewState)
    hasher.combine(artifact.workflowState)
  }
  return hasher.finalize()
}

func workPendingSteersRenderSignature(_ steers: [WorkPendingSteerModel]) -> Int {
  var hasher = Hasher()
  hasher.combine(steers.count)
  for steer in steers {
    hasher.combine(steer.id)
    hasher.combine(steer.text.utf8.count)
    hasher.combine(steer.text.hashValue)
    hasher.combine(steer.turnId)
    hasher.combine(steer.timestamp)
  }
  return hasher.finalize()
}

func workLocalEchoMessagesRenderSignature(_ messages: [WorkLocalEchoMessage]) -> Int {
  var hasher = Hasher()
  hasher.combine(messages.count)
  for message in messages {
    hasher.combine(message.id)
    hasher.combine(message.text.utf8.count)
    hasher.combine(message.text.hashValue)
    hasher.combine(message.timestamp)
    hasher.combine(message.deliveryState)
    hasher.combine(message.attachments?.count ?? 0)
    for attachment in message.attachments ?? [] {
      hasher.combine(attachment.path)
      hasher.combine(attachment.type)
      hasher.combine(attachment.url)
    }
  }
  return hasher.finalize()
}

func workExpandedToolCardIdsRenderSignature(_ ids: Set<String>) -> Int {
  var hasher = Hasher()
  hasher.combine(ids.count)
  for id in ids.sorted() {
    hasher.combine(id)
  }
  return hasher.finalize()
}

func workSubagentSnapshotsRenderSignature(_ snapshots: [WorkSubagentSnapshot]) -> Int {
  var hasher = Hasher()
  hasher.combine(snapshots.count)
  for snapshot in snapshots {
    hasher.combine(snapshot.taskId)
    hasher.combine(snapshot.agentId)
    hasher.combine(snapshot.agentType)
    hasher.combine(snapshot.parentToolUseId)
    hasher.combine(snapshot.description)
    hasher.combine(snapshot.background)
    hasher.combine(snapshot.status)
    hasher.combine(snapshot.lastToolName)
    hasher.combine(snapshot.latestSummary)
    hasher.combine(snapshot.turnId)
    hasher.combine(snapshot.startedAt)
    hasher.combine(snapshot.updatedAt)
  }
  return hasher.finalize()
}

func workScheduledWorkSnapshotsRenderSignature(_ snapshots: [WorkScheduledWorkSnapshot]) -> Int {
  var hasher = Hasher()
  hasher.combine(snapshots.count)
  for snapshot in snapshots {
    hasher.combine(snapshot.id)
    hasher.combine(snapshot.kind)
    hasher.combine(snapshot.status)
    hasher.combine(snapshot.origin)
    hasher.combine(snapshot.title)
    hasher.combine(snapshot.summary)
    hasher.combine(snapshot.prompt)
    hasher.combine(snapshot.reason)
    hasher.combine(snapshot.cron)
    hasher.combine(snapshot.nextRunAt)
    hasher.combine(snapshot.lastRunAt)
    hasher.combine(snapshot.recurring)
    hasher.combine(snapshot.durable)
    hasher.combine(snapshot.sourceToolUseId)
    hasher.combine(snapshot.sourceTaskId)
    hasher.combine(snapshot.turnId)
    hasher.combine(snapshot.error)
    hasher.combine(snapshot.createdAt)
    hasher.combine(snapshot.updatedAt)
  }
  return hasher.finalize()
}

func workLaneListRenderSignature(_ lanes: [LaneSummary]) -> Int {
  var hasher = Hasher()
  hasher.combine(lanes.count)
  for lane in lanes {
    hasher.combine(lane.id)
    hasher.combine(lane.name)
    hasher.combine(lane.color)
    hasher.combine(lane.icon)
    hasher.combine(lane.status.dirty)
    hasher.combine(lane.status.ahead)
    hasher.combine(lane.status.behind)
  }
  return hasher.finalize()
}

/// Hard ceiling for a pending-input card, given the height available to the
/// whole chat surface. Always leaves room for the composer plus a slice of
/// transcript — a gate that covers the entire screen reads as a modal takeover
/// and hides the Send button. Long content scrolls inside the card instead of
/// growing it.
///
/// If a card's irreducible chrome still exceeds this on a small phone with the
/// keyboard up, the overflow is absorbed by the transcript, not the composer:
/// the composer inset is `fixedSize(vertical:)` and the transcript scroll view
/// is the flexible sibling, so Send/Decline stay on screen either way. That
/// ordering is the actual guarantee — this number just keeps the common case
/// from getting there.
///
/// A free function rather than a view property so previews exercise the same
/// arithmetic the app uses; the numbers had drifted into three hand-copied
/// literals otherwise.
func workPendingInputMaxHeight(chatSurfaceHeight: CGFloat) -> CGFloat {
  // Roughly the composer card's own height in its resting single-line state.
  // Measuring it for real is not an option: `composerLayoutHeight` includes the
  // strip we are sizing, so reading it here would be circular.
  let composerReserve: CGFloat = 110
  let available = max(0, chatSurfaceHeight - composerReserve)
  return max(160, min(available * 0.82, chatSurfaceHeight * 0.62))
}

/// Budget for the inline-in-transcript question card, which is bounded by the
/// transcript viewport rather than the whole surface (the composer sits below
/// that viewport either way, so there is nothing to reserve for it). Kept beside
/// `workPendingInputMaxHeight` so the two rules' divergence is deliberate and
/// visible instead of an inline literal drifting on its own.
func workInlinePendingInputMaxHeight(transcriptViewportHeight: CGFloat) -> CGFloat {
  max(240, transcriptViewportHeight * 0.62)
}

private struct WorkChatViewportHeightPreferenceKey: PreferenceKey {
  static var defaultValue: CGFloat = 0

  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
    let next = nextValue()
    if next > 0 { value = next }
  }
}


private struct WorkChatViewportWidthPreferenceKey: PreferenceKey {
  static var defaultValue: CGFloat = 0

  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
    let next = nextValue()
    if next > 0 { value = next }
  }
}

private struct WorkChatComposerLayoutHeightPreferenceKey: PreferenceKey {
  static var defaultValue: CGFloat = 0

  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
    let next = nextValue()
    if next > 0 { value = next }
  }
}

private struct WorkChatContentBottomPreferenceKey: PreferenceKey {
  static var defaultValue: CGFloat = 0

  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
    value = nextValue()
  }
}

private struct WorkChatContentTopPreferenceKey: PreferenceKey {
  static var defaultValue: CGFloat = -CGFloat.greatestFiniteMagnitude

  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
    value = max(value, nextValue())
  }
}

/// Flat transcript canvas. Desktop parity: a single dark #0f0f11 fill behind
/// the agent prose — no card, no gradient. Light mode keeps the app's warm
/// paper tone so the chat doesn't look out of place there.
let workChatCanvasBackground = Color(uiColor: UIColor { traits in
  traits.userInterfaceStyle == .dark
    ? UIColor(red: 0x0f / 255.0, green: 0x0f / 255.0, blue: 0x11 / 255.0, alpha: 1)
    : UIColor(red: 0xf5 / 255.0, green: 0xf3 / 255.0, blue: 0xf0 / 255.0, alpha: 1)
})

private struct WorkChatNavigationBackdrop: View {
  var body: some View {
    LinearGradient(
      colors: [
        workChatCanvasBackground,
        workChatCanvasBackground.opacity(0.96),
        workChatCanvasBackground.opacity(0)
      ],
      startPoint: .top,
      endPoint: .bottom
    )
    .frame(height: 112)
    .ignoresSafeArea(edges: .top)
    .allowsHitTesting(false)
  }
}

private struct WorkChatComposerBackdrop: View {
  var body: some View {
    LinearGradient(
      colors: [
        workChatCanvasBackground.opacity(0.98),
        workChatCanvasBackground.opacity(0.94),
        workChatCanvasBackground
      ],
      startPoint: .top,
      endPoint: .bottom
    )
    .ignoresSafeArea(edges: .bottom)
    .allowsHitTesting(false)
  }
}

struct WorkTimelinePresentation: Equatable {
  let visibleEntries: [WorkTimelineEntry]
  let renderEntries: [WorkTimelineRenderEntry]
  let timelineCount: Int
  let timelineFirstId: String?
  let timelineLastId: String?
  let hiddenCount: Int
  let signature: Int

  static let empty = WorkTimelinePresentation(
    visibleEntries: [],
    renderEntries: [],
    timelineCount: 0,
    timelineFirstId: nil,
    timelineLastId: nil,
    hiddenCount: 0,
    signature: 0
  )

  static func == (lhs: WorkTimelinePresentation, rhs: WorkTimelinePresentation) -> Bool {
    lhs.signature == rhs.signature
  }
}

private func makeWorkTimelinePresentation(
  timeline: [WorkTimelineEntry],
  visibleCount: Int,
  chatSummary: WorkChatSummaryRenderContext,
  transcript: [WorkChatEnvelope],
  assistantPreviewCache: WorkAssistantPreviewCache,
  assistantLineBudgets: [String: Int],
  streamingAssistantMessageId: String?
) -> WorkTimelinePresentation {
  let rawVisibleEntries = visibleWorkTimelineEntries(from: timeline, visibleCount: visibleCount)
  let visibleEntriesWithSeparators = injectWorkTurnSeparators(
    into: rawVisibleEntries,
    provider: chatSummary.provider,
    model: chatSummary.model,
    modelId: chatSummary.modelId,
    transcript: transcript
  )
  let visibleEntries = workTimelineEntriesWithAssistantPreviews(
    visibleEntriesWithSeparators,
    cache: assistantPreviewCache,
    assistantLineBudgets: assistantLineBudgets,
    tailAnchoredAssistantMessageId: workLatestAssistantMessageId(in: timeline)
  )
  let renderEntries = workTimelineRenderEntries(
    from: visibleEntries,
    streamingAssistantMessageId: streamingAssistantMessageId,
    splitAssistantMessageId: workLatestAssistantMessageId(in: timeline),
    assistantLineBudgets: assistantLineBudgets
  )
  let hiddenCount = max(timeline.count - rawVisibleEntries.count, 0)
  return WorkTimelinePresentation(
    visibleEntries: visibleEntries,
    renderEntries: renderEntries,
    timelineCount: timeline.count,
    timelineFirstId: timeline.first?.id,
    timelineLastId: timeline.last?.id,
    hiddenCount: hiddenCount,
    signature: workTimelinePresentationSignature(
      timelineCount: timeline.count,
      timelineFirstId: timeline.first?.id,
      timelineLastId: timeline.last?.id,
      visibleEntries: visibleEntries,
      renderEntries: renderEntries,
      hiddenCount: hiddenCount
    )
  )
}

func workTimelineVisibleCountAfterHistoryPrepend(
  currentVisibleCount: Int,
  prependedCount: Int
) -> Int {
  max(0, currentVisibleCount) + min(max(0, prependedCount), workTimelinePageSize)
}

private func workTimelinePresentationSignature(
  timelineCount: Int,
  timelineFirstId: String?,
  timelineLastId: String?,
  visibleEntries: [WorkTimelineEntry],
  renderEntries: [WorkTimelineRenderEntry],
  hiddenCount: Int
) -> Int {
  var hasher = Hasher()
  hasher.combine(hiddenCount)
  hasher.combine(timelineCount)
  hasher.combine(timelineFirstId)
  hasher.combine(timelineLastId)
  hasher.combine(visibleEntries.count)
  hasher.combine(visibleEntries.first?.id)
  hasher.combine(visibleEntries.last?.id)
  hasher.combine(renderEntries.count)
  for entry in renderEntries {
    hasher.combine(entry.id)
    hasher.combine(entry.sourceEntryId)
    hasher.combine(entry.timestamp)
    switch entry.payload {
    case .entry(let timelineEntry):
      hasher.combine(timelineEntry.id)
      hasher.combine(timelineEntry.timestamp)
      hasher.combine(timelineEntry.rank)
      if case .message(let message) = timelineEntry.payload {
        hasher.combine(message.id)
        hasher.combine(message.role)
        hasher.combine(message.steerId)
        hasher.combine(message.deliveryState)
        hasher.combine(message.processed)
        hasher.combine(message.unprocessedResolution?.action)
        hasher.combine(message.unprocessedResolution?.state)
        hasher.combine(message.unprocessedResolution?.resolvedAt)
        workTimelineCombineTextSignature(message.markdown, into: &hasher)
        if let preview = message.assistantPreview {
          workTimelineCombineTextSignature(preview.text, into: &hasher)
          hasher.combine(preview.isTruncated)
          hasher.combine(preview.visibleLineCount)
          hasher.combine(preview.totalLineCount)
        }
      }
    case .assistantMarkdownBlock(let model):
      hasher.combine(model.id)
      hasher.combine(model.messageId)
      hasher.combine(model.block.id)
      workTimelineCombineTextSignature(model.block.kind.cacheKey, into: &hasher)
    case .assistantMonospaced(let model):
      hasher.combine(model.id)
      hasher.combine(model.messageId)
      workTimelineCombineTextSignature(model.text, into: &hasher)
      workTimelineCombineTextSignature(model.accessibilityLabel, into: &hasher)
    case .assistantControls(let model):
      hasher.combine(model.id)
      hasher.combine(model.messageId)
      hasher.combine(model.summaryText)
      hasher.combine(model.visibleLineCount)
      hasher.combine(model.totalLineCount)
      hasher.combine(model.canShowMore)
      hasher.combine(model.nextLineBudget)
    }
  }
  return hasher.finalize()
}

private func workTimelineCombineTextSignature(_ text: String, into hasher: inout Hasher) {
  hasher.combine(text.utf8.count)
  hasher.combine(text.hashValue)
}

private func workTimelineEntriesWithAssistantPreviews(
  _ entries: [WorkTimelineEntry],
  cache: WorkAssistantPreviewCache,
  assistantLineBudgets: [String: Int],
  tailAnchoredAssistantMessageId: String?
) -> [WorkTimelineEntry] {
  var visibleAssistantMessageIds = Set<String>()
  let hydratedEntries = entries.map { entry -> WorkTimelineEntry in
    guard case .message(var message) = entry.payload,
          message.role == "assistant"
    else { return entry }

    visibleAssistantMessageIds.insert(message.id)
    let previewAnchor: WorkAssistantMessagePreviewAnchor = message.id == tailAnchoredAssistantMessageId ? .tail : .head
    let baselinePreview = cache.preview(for: message, anchor: previewAnchor)
    let tailCanRenderFull = previewAnchor == .tail
      && !baselinePreview.usesMonospacedRendering
      && baselinePreview.totalLineCount <= workAssistantMessageTailFullLineBudget
      && baselinePreview.totalCharacterCount <= workAssistantMessageTailFullCharacterBudget
    let lineBudget = assistantLineBudgets[message.id]
      ?? (tailCanRenderFull ? workAssistantMessageTailFullLineBudget : workAssistantMessageInitialLineBudget)
    let characterBudget = workAssistantMessageCharacterBudget(
      forLineBudget: lineBudget,
      tailCanRenderFull: tailCanRenderFull && assistantLineBudgets[message.id] == nil
    )
    if lineBudget == workAssistantMessageInitialLineBudget {
      message.assistantPreview = baselinePreview
    } else {
      message.assistantPreview = workAssistantMessagePreview(
        message.markdown,
        lineBudget: lineBudget,
        characterBudget: characterBudget,
        anchor: previewAnchor,
        classification: baselinePreview.usesMonospacedRendering
      )
    }
    return WorkTimelineEntry(
      id: entry.id,
      timestamp: entry.timestamp,
      rank: entry.rank,
      payload: .message(message)
    )
  }
  cache.prune(keeping: visibleAssistantMessageIds)
  return hydratedEntries
}

private func workLatestAssistantMessageId(in timeline: [WorkTimelineEntry]) -> String? {
  for entry in timeline.reversed() {
    guard case .message(let message) = entry.payload,
          message.role == "assistant"
    else { continue }
    return message.id
  }
  return nil
}

func workTimelineRenderEntries(
  from entries: [WorkTimelineEntry],
  streamingAssistantMessageId: String?,
  splitAssistantMessageId: String? = nil,
  assistantLineBudgets: [String: Int] = [:]
) -> [WorkTimelineRenderEntry] {
  var rendered: [WorkTimelineRenderEntry] = []
  rendered.reserveCapacity(entries.count)

  for entry in entries {
    guard case .message(let message) = entry.payload,
          message.role == "assistant"
    else {
      rendered.append(WorkTimelineRenderEntry(
        id: entry.id,
        sourceEntryId: entry.id,
        timestamp: entry.timestamp,
        payload: .entry(entry)
      ))
      continue
    }

    let preview = message.assistantPreview ?? workInitialAssistantMessagePreview(message.markdown)
    let shouldSplitAssistantMessage = (
      message.id == streamingAssistantMessageId
      || message.id == splitAssistantMessageId
    )
    guard shouldSplitAssistantMessage else {
      rendered.append(WorkTimelineRenderEntry(
        id: entry.id,
        sourceEntryId: entry.id,
        timestamp: entry.timestamp,
        payload: .entry(entry)
      ))
      continue
    }

    let requestedLineBudget = assistantLineBudgets[message.id] ?? workAssistantMessageInitialLineBudget
    // One bounded step per tap, with no ceiling. A 1000-line answer is reached
    // by tapping "Show more" until it is all here; the reader is never left
    // with a truncated message and no way to see the rest.
    let nextLineBudget = requestedLineBudget + workAssistantMessageLineBudgetStep
    let accessibilityLabel = workAssistantMessageAccessibilityLabel(preview)

    // A truncated tail can start inside a fenced tree and omit the opening
    // fence. Classify the authoritative full message so markdown prose never
    // flips into the tiny whole-message monospace renderer while paginating.
    if preview.usesMonospacedRendering {
      let model = WorkAssistantMonospacedRenderModel(
        id: "\(entry.id)-assistant-monospace",
        messageId: message.id,
        turnId: message.turnId,
        itemId: message.itemId,
        text: preview.text,
        accessibilityLabel: accessibilityLabel
      )
      rendered.append(WorkTimelineRenderEntry(
        id: model.id,
        sourceEntryId: entry.id,
        timestamp: entry.timestamp,
        payload: .assistantMonospaced(model)
      ))
    } else {
      let blocks = message.id == streamingAssistantMessageId
        ? parseMarkdownBlocksForStreaming(preview.text, cacheKey: "\(message.id):preview")
        : parseMarkdownBlocks(preview.text)
      rendered.reserveCapacity(rendered.count + blocks.count + (preview.isTruncated ? 1 : 0))
      for block in blocks {
        let model = WorkAssistantMarkdownBlockRenderModel(
          id: "\(entry.id)-\(block.id)",
          messageId: message.id,
          turnId: message.turnId,
          itemId: message.itemId,
          block: block
        )
        rendered.append(WorkTimelineRenderEntry(
          id: model.id,
          sourceEntryId: entry.id,
          timestamp: entry.timestamp,
          payload: .assistantMarkdownBlock(model)
        ))
      }
    }

    if preview.isTruncated {
      let controls = WorkAssistantMessageControlsModel(
        id: "\(entry.id)-assistant-controls",
        messageId: message.id,
        summaryText: workAssistantMessagePreviewSummaryText(preview),
        visibleLineCount: preview.visibleLineCount,
        totalLineCount: preview.totalLineCount,
        // Truncated means there is more to show, and there is always a next
        // step that shows it — the control only disappears once the whole
        // message is rendered and this branch stops running.
        canShowMore: true,
        nextLineBudget: nextLineBudget
      )
      rendered.append(WorkTimelineRenderEntry(
        id: controls.id,
        sourceEntryId: entry.id,
        timestamp: entry.timestamp,
        payload: .assistantControls(controls)
      ))
    }
  }

  return rendered
}

func mergeWorkPendingSteers(
  optimistic: [WorkPendingSteerModel],
  canonical: [WorkPendingSteerModel]
) -> [WorkPendingSteerModel] {
  guard !optimistic.isEmpty else { return canonical }
  guard !canonical.isEmpty else { return optimistic }
  var seen = Set<String>()
  var result: [WorkPendingSteerModel] = []
  for steer in optimistic + canonical {
    guard seen.insert(steer.id).inserted else { continue }
    result.append(steer)
  }
  return result
}

private struct WorkChatComposerCard: View {
  let chatSummary: WorkChatSummaryRenderContext
  let usageViewModel: WorkContextUsageViewModel?
  let laneId: String
  let dictationTargetId: String
  let awaitingInputGate: Bool
  let composerPlaceholder: String
  let canCompose: Bool
  let canSend: Bool
  let attachmentsAvailable: Bool
  let canUploadAttachments: Bool
  let sending: Bool
  let settingsMutationInFlight: Bool
  let codexFastModeOverride: Bool?
  let composerDraftRestore: WorkChatComposerDraftRestore?
  let draftPersistenceKey: String
  let compact: Bool
  /// True while the assistant is streaming a response. Swaps the Send button
  /// Desktop parity: red bordered stop control in the composer while a turn is
  /// active (`border-red-500/25 bg-red-500/[0.08] text-red-400/80`).
  /// old full-width yellow slab that used to sit under the header.
  let showInterrupt: Bool
  let activeSendModesAvailable: Bool
  let queueAwareStopAvailable: Bool
  let interruptInFlight: Bool
  let onInterrupt: @MainActor (AgentChatStopMode) async -> Void
  let onOpenModelPicker: (() -> Void)?
  let onSelectRuntimeMode: ((String) -> Void)?
  let onSend: @MainActor (String, [WorkChatInputAttachment], WorkActiveSendMode) async -> Bool
  let onSent: () -> Void

  var body: some View {
    WorkChatComposerDraftInput(
      chatSummary: chatSummary,
      usageViewModel: usageViewModel,
      laneId: laneId,
      dictationTargetId: dictationTargetId,
      awaitingInputGate: awaitingInputGate,
      composerPlaceholder: composerPlaceholder,
      canCompose: canCompose,
      canSend: canSend,
      attachmentsAvailable: attachmentsAvailable,
      canUploadAttachments: canUploadAttachments,
      sending: sending,
      settingsMutationInFlight: settingsMutationInFlight,
      codexFastModeOverride: codexFastModeOverride,
      composerDraftRestore: composerDraftRestore,
      draftPersistenceKey: draftPersistenceKey,
      compact: compact,
      showInterrupt: showInterrupt,
      activeSendModesAvailable: activeSendModesAvailable,
      queueAwareStopAvailable: queueAwareStopAvailable,
      interruptInFlight: interruptInFlight,
      onInterrupt: onInterrupt,
      onOpenModelPicker: onOpenModelPicker,
      onSelectRuntimeMode: onSelectRuntimeMode,
      onSend: onSend,
      onSent: onSent
    )
    .padding(.horizontal, 12)
    .padding(.vertical, compact ? 8 : 10)
    .background(composerSurface)
  }

  private var composerSurface: some View {
    RoundedRectangle(cornerRadius: 24, style: .continuous)
      .fill(ADEColor.composerBackground)
      .overlay(
        RoundedRectangle(cornerRadius: 24, style: .continuous)
          .stroke(ADEColor.glassBorder, lineWidth: 1)
      )
  }
}

private struct WorkChatComposerDraftInput: View {
  let chatSummary: WorkChatSummaryRenderContext
  let usageViewModel: WorkContextUsageViewModel?
  let laneId: String
  let dictationTargetId: String
  let awaitingInputGate: Bool
  let composerPlaceholder: String
  let canCompose: Bool
  let canSend: Bool
  let attachmentsAvailable: Bool
  let canUploadAttachments: Bool
  let sending: Bool
  let settingsMutationInFlight: Bool
  let codexFastModeOverride: Bool?
  let composerDraftRestore: WorkChatComposerDraftRestore?
  /// Key this chat's unsent text is persisted under, so leaving and coming back
  /// restores it (matching desktop). Empty disables persistence.
  let draftPersistenceKey: String
  let compact: Bool
  let showInterrupt: Bool
  let activeSendModesAvailable: Bool
  let queueAwareStopAvailable: Bool
  let interruptInFlight: Bool
  let onInterrupt: @MainActor (AgentChatStopMode) async -> Void
  let onOpenModelPicker: (() -> Void)?
  let onSelectRuntimeMode: ((String) -> Void)?
  let onSend: @MainActor (String, [WorkChatInputAttachment], WorkActiveSendMode) async -> Bool
  let onSent: () -> Void

  @EnvironmentObject private var syncService: SyncService
  @StateObject private var draftState = WorkChatComposerDraftState()
  @StateObject private var suggestionController = WorkComposerSuggestionController()
  @State private var contextUsagePresented = false
  @StateObject private var dictationCoordinator = DictationInsertionCoordinator()
  @State private var isDictating = false
  @State private var inputAttachments: [WorkChatInputAttachment] = []
  @State private var attachmentPickerPresented = false
  @State private var stopMode: AgentChatStopMode = .stopAndClear
  @State private var stopOptionsPresented = false
  @State private var stopHapticToken = 0
  @State private var activeSendMode: WorkActiveSendMode = .inline
  @State private var sendOptionsPresented = false

  private var hasSendableDraftOrAttachment: Bool {
    draftState.hasSendableText || !workChatInputReadyAttachments(inputAttachments).isEmpty
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if compact {
        WorkComposerSuggestionStrip(controller: suggestionController)
          .animation(.smooth(duration: 0.16), value: suggestionController.isVisible)

        WorkChatInputAttachmentTray(attachments: $inputAttachments)

        HStack(alignment: .center, spacing: 8) {
          if !isDictating {
            WorkChatAttachmentAddButton(
              pickerPresented: $attachmentPickerPresented,
              attachmentCount: inputAttachments.count,
              disabled: !canCompose || !attachmentsAvailable || settingsMutationInFlight
            )

            WorkChatComposerTextField(
              draftState: draftState,
              controller: suggestionController,
              canCompose: canCompose,
              placeholder: composerPlaceholder,
              acceptsPastedImages: canCompose && attachmentsAvailable,
              onPasteImages: { images in
                workChatInputPasteImages(images, into: $inputAttachments)
              },
              maxLines: 1
            )
          }

          DictationMicButton(
            draft: $draftState.text,
            coordinator: dictationCoordinator,
            targetId: dictationTargetId,
            onRecordingChange: { isDictating = $0 }
          )
          .frame(maxWidth: isDictating ? .infinity : nil)

          if !isDictating {
            sendOrInterruptControls()
          }
        }
      } else {
        WorkComposerSuggestionStrip(controller: suggestionController)
          .animation(.smooth(duration: 0.16), value: suggestionController.isVisible)

        WorkChatInputAttachmentTray(attachments: $inputAttachments)

        WorkChatComposerTextField(
          draftState: draftState,
          controller: suggestionController,
          canCompose: canCompose,
          placeholder: composerPlaceholder,
          acceptsPastedImages: canCompose && attachmentsAvailable,
          onPasteImages: { images in
            workChatInputPasteImages(images, into: $inputAttachments)
          }
        )

        if showInterrupt && hasSendableDraftOrAttachment {
          Text(activeTurnSendHint)
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("Work.Chat.Composer.StagingHint")
        }

        HStack(alignment: .center, spacing: 8) {
        // Leading controls collapse while dictating so the recording pill can
        // expand into the row without a layout jump.
        if !isDictating {
          WorkChatAttachmentAddButton(
            pickerPresented: $attachmentPickerPresented,
            attachmentCount: inputAttachments.count,
            disabled: !canCompose || !attachmentsAvailable || settingsMutationInFlight
          )

          WorkComposerChipStrip(
            chatSummary: chatSummary,
            settingsMutationInFlight: settingsMutationInFlight,
            codexFastModeOverride: codexFastModeOverride,
            onOpenModelPicker: onOpenModelPicker,
            onSelectRuntimeMode: onSelectRuntimeMode
          )

          DictationRawUndoChip(coordinator: dictationCoordinator, draft: $draftState.text)

          Spacer(minLength: 0)

          if let usageViewModel {
            WorkContextUsageMeter(
              usage: usageViewModel,
              active: showInterrupt,
              isPresented: $contextUsagePresented
            )
            .popover(
              isPresented: $contextUsagePresented,
              attachmentAnchor: .rect(.bounds),
              arrowEdge: .bottom
            ) {
              WorkContextUsagePopover(
                usage: usageViewModel,
                modelLabel: chatSummary.modelLabel
              )
              .frame(maxWidth: 320, alignment: .leading)
              .presentationCompactAdaptation(.popover)
            }
          }
        }

        // Single mic control: renders the 28×28 mic when idle and the inline
        // recording pill (full-width) while recording.
        DictationMicButton(
          draft: $draftState.text,
          coordinator: dictationCoordinator,
          targetId: dictationTargetId,
          onRecordingChange: { isDictating = $0 }
        )
        .frame(maxWidth: isDictating ? .infinity : nil)

          if !isDictating {
            sendOrInterruptControls()
          }
        }
      }
    }
    .onChange(of: usageViewModel) { _, newValue in
      if newValue == nil {
        contextUsagePresented = false
      }
    }
    .onAppear {
      configureSuggestionController()
    }
    // Bind before applying a restore: `bind` only seeds an empty field, so a
    // failed-send restore that runs first would be preserved either way, but
    // binding first keeps the persisted key correct for the very first autosave.
    .task(id: draftPersistenceKey) {
      stopMode = UserDefaults.standard.string(forKey: "\(draftPersistenceKey).stopMode") == AgentChatStopMode.stopOnly.rawValue
        ? .stopOnly
        : .stopAndClear
      activeSendMode = .inline
      sendOptionsPresented = false
      stopOptionsPresented = false
      draftState.bind(persistenceKey: draftPersistenceKey)
    }
    .task(id: composerDraftRestore?.id) {
      draftState.applyRestore(composerDraftRestore)
    }
    // The 400ms autosave debounce can't survive a navigation pop; flush here so
    // backing out of a chat mid-sentence keeps the sentence.
    .onDisappear { draftState.flushDraft() }
    .onChange(of: showInterrupt) { _, _ in
      activeSendMode = .inline
      sendOptionsPresented = false
      stopOptionsPresented = false
    }
    .onChange(of: chatSummary.provider) { _, _ in
      activeSendMode = .inline
      sendOptionsPresented = false
      stopOptionsPresented = false
      configureSuggestionController()
    }
    .onChange(of: laneId) { _, _ in configureSuggestionController() }
    .workChatAttachmentPicker(
      isPresented: $attachmentPickerPresented,
      attachments: $inputAttachments,
      onDismiss: {
        if canCompose { draftState.isFocused = true }
      }
    )
  }

  @ViewBuilder
  private func sendOrInterruptControls() -> some View {
    if showInterrupt {
      if hasSendableDraftOrAttachment {
        stopButton()
        if chatSummary.provider.lowercased() == "claude" && activeSendModesAvailable {
          activeTurnSendButton()
        } else {
          WorkChatComposerSendButton(
            draftState: draftState,
            attachments: $inputAttachments,
            canSend: canSend,
            canUploadAttachments: canUploadAttachments,
            sending: sending,
            accessibilityLabelText: "Stage message",
            onSend: { text, attachments in
              await onSend(text, attachments, .queue)
            },
            onSent: onSent
          )
        }
      } else {
        stopButton()
      }
    } else {
      WorkChatComposerSendButton(
        draftState: draftState,
        attachments: $inputAttachments,
        canSend: canSend,
        canUploadAttachments: canUploadAttachments,
        sending: sending,
        onSend: { text, attachments in
          await onSend(text, attachments, .queue)
        },
        onSent: onSent
      )
    }
  }

  @ViewBuilder
  private func activeTurnSendButton() -> some View {
    HStack(spacing: 0) {
      WorkChatComposerSendButton(
        draftState: draftState,
        attachments: $inputAttachments,
        canSend: canSend,
        canUploadAttachments: canUploadAttachments,
        sending: sending,
        accessibilityLabelText: activeSendModeTitle,
        systemImageName: activeSendModeIcon,
        minimumTapTargetSize: 32,
        onSend: { text, attachments in
          await onSend(text, attachments, activeSendMode)
        },
        onSent: onSent
      )

      Button {
        sendOptionsPresented.toggle()
      } label: {
        Image(systemName: "chevron.down")
          .font(.system(size: 9, weight: .bold))
          .foregroundStyle(Color(red: 0.12, green: 0.12, blue: 0.14))
          .frame(width: 24, height: 32)
          .background(Color.white.opacity(0.9))
      }
      .buttonStyle(.plain)
      .accessibilityLabel("More send options")
      .accessibilityValue(activeSendModeTitle)
      .accessibilityHint("Choose whether this message sends during, after, or by interrupting the active Claude turn")
      .popover(isPresented: $sendOptionsPresented, arrowEdge: .bottom) {
        VStack(alignment: .leading, spacing: 0) {
          activeSendOption(
            mode: .inline,
            title: "Send during turn",
            detail: "Claude picks this up after the current tool step.",
            systemImage: "arrow.turn.down.right"
          )
          Divider()
          activeSendOption(
            mode: .queue,
            title: "Send after turn",
            detail: "Keep this message staged until the turn finishes.",
            systemImage: "clock"
          )
          Divider()
          activeSendOption(
            mode: .interrupt,
            title: "Interrupt & send",
            detail: "Stop the current model step and redirect Claude now.",
            systemImage: "bolt.fill"
          )
        }
        .frame(width: 270)
        .presentationCompactAdaptation(.popover)
      }
    }
    .clipShape(Capsule())
  }

  private var activeSendModeTitle: String {
    switch activeSendMode {
    case .queue: return "Send after turn"
    case .interrupt: return "Interrupt and send"
    default: return "Send during turn"
    }
  }

  private var activeSendModeIcon: String {
    switch activeSendMode {
    case .queue: return "clock"
    case .interrupt: return "bolt.fill"
    default: return "arrow.turn.down.right"
    }
  }

  private var activeTurnSendHint: String {
    guard chatSummary.provider.lowercased() == "claude", activeSendModesAvailable else {
      return "Message will stage behind the active turn."
    }
    switch activeSendMode {
    case .queue: return "Message will send after the active turn."
    case .interrupt: return "Message will interrupt and redirect Claude."
    default: return "Message will reach Claude during the active turn."
    }
  }

  @ViewBuilder
  private func activeSendOption(mode: WorkActiveSendMode, title: String, detail: String, systemImage: String) -> some View {
    Button {
      activeSendMode = mode
      sendOptionsPresented = false
    } label: {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: systemImage)
          .font(.caption.weight(.semibold))
          .foregroundStyle(mode == .interrupt ? ADEColor.warning : ADEColor.accent)
          .frame(width: 16)
        VStack(alignment: .leading, spacing: 2) {
          Text(title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text(detail)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
        Spacer(minLength: 4)
        if activeSendMode == mode {
          Image(systemName: "checkmark")
            .font(.caption.weight(.bold))
            .foregroundStyle(ADEColor.accent)
        }
      }
      .padding(12)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }

  private func configureSuggestionController() {
    suggestionController.provider = chatSummary.provider
    suggestionController.laneId = laneId.isEmpty ? nil : laneId
    suggestionController.syncService = syncService
  }

  @ViewBuilder
  private func stopButton() -> some View {
    if chatSummary.provider.lowercased() == "claude" && queueAwareStopAvailable {
      HStack(spacing: 0) {
        Button {
          stopHapticToken &+= 1
          Task { await onInterrupt(stopMode) }
        } label: {
          stopButtonModeIcon()
            .foregroundStyle(ADEColor.danger.opacity(0.85))
            .frame(width: 32, height: 32)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(stopMode == .stopOnly ? "Stop turn and keep queue" : "Stop turn and clear queue")
        .disabled(interruptInFlight)

        Button {
          stopOptionsPresented.toggle()
        } label: {
          Image(systemName: "chevron.down")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(ADEColor.danger.opacity(0.72))
            .frame(width: 24, height: 32)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("More stop options")
        .accessibilityValue(stopMode == .stopOnly ? "Stop only" : "Stop and clear queue")
        .accessibilityHint("Choose whether queued Claude messages are kept or cancelled")
        .disabled(interruptInFlight)
        .popover(isPresented: $stopOptionsPresented, arrowEdge: .bottom) {
          VStack(alignment: .leading, spacing: 0) {
            stopOption(
              mode: .stopAndClear,
              title: "Stop & clear queue",
              detail: "Stop this turn and cancel staged Claude messages.",
              systemImage: "trash"
            )
            Divider()
            stopOption(
              mode: .stopOnly,
              title: "Stop only",
              detail: "Stop this turn and keep staged messages.",
              systemImage: "stop.fill"
            )
          }
          .frame(width: 260)
          .presentationCompactAdaptation(.popover)
        }
      }
      .background(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .fill(ADEColor.danger.opacity(0.08))
      )
      .overlay {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .stroke(ADEColor.danger.opacity(0.25), lineWidth: 1)
      }
      .sensoryFeedback(.impact(weight: .medium), trigger: stopHapticToken)
    } else {
      Button {
        stopHapticToken &+= 1
        Task { await onInterrupt(.stopAndClear) }
      } label: {
        stopButtonIcon()
        .foregroundStyle(ADEColor.danger.opacity(0.85))
        .frame(width: 28, height: 28)
        .background(
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(ADEColor.danger.opacity(0.08))
        )
        .overlay(
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .stroke(ADEColor.danger.opacity(0.25), lineWidth: 1)
        )
      }
      .buttonStyle(.plain)
      .accessibilityLabel(interruptInFlight ? "Interrupting turn" : "Stop turn")
      .disabled(interruptInFlight)
      .sensoryFeedback(.impact(weight: .medium), trigger: stopHapticToken)
      .adeInspectable(
        "Work.Chat.Composer.StopButton",
        metadata: [
          "label": interruptInFlight ? "Interrupting turn" : "Stop turn",
          "role": "button"
        ]
      )
    }
  }

  @ViewBuilder
  private func stopOption(mode: AgentChatStopMode, title: String, detail: String, systemImage: String) -> some View {
    Button {
      stopMode = mode
      UserDefaults.standard.set(mode.rawValue, forKey: "\(draftPersistenceKey).stopMode")
      stopOptionsPresented = false
    } label: {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: systemImage)
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.danger)
          .frame(width: 16)
        VStack(alignment: .leading, spacing: 2) {
          Text(title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text(detail)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
        Spacer(minLength: 4)
        if stopMode == mode {
          Image(systemName: "checkmark")
            .font(.caption.weight(.bold))
            .foregroundStyle(ADEColor.accent)
        }
      }
      .padding(12)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }

  @ViewBuilder
  private func stopButtonIcon() -> some View {
    if interruptInFlight {
      ProgressView()
        .controlSize(.mini)
        .tint(ADEColor.danger)
    } else {
      Image(systemName: "stop.fill")
        .font(.system(size: 10, weight: .bold))
    }
  }

  @ViewBuilder
  private func stopButtonModeIcon() -> some View {
    if interruptInFlight {
      ProgressView()
        .controlSize(.mini)
        .tint(ADEColor.danger)
    } else if stopMode == .stopOnly {
      Image(systemName: "stop.fill")
        .font(.system(size: 10, weight: .bold))
    } else {
      Image(systemName: "trash")
        .font(.system(size: 11, weight: .bold))
    }
  }
}

private struct WorkQueueRecoveryBanner: View {
  let recovery: WorkQueueRecoveryModel
  let restoring: Bool
  let enabled: Bool
  let onRestore: @MainActor () async -> Void

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: "arrow.uturn.backward.circle.fill")
        .font(.body)
        .foregroundStyle(ADEColor.warning)

      Text("\(recovery.messageCount) queued message\(recovery.messageCount == 1 ? "" : "s") cancelled")
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)

      Spacer(minLength: 4)

      Button {
        Task { await onRestore() }
      } label: {
        Group {
          if restoring {
            ProgressView()
              .controlSize(.small)
          } else {
            Text("Undo")
              .font(.caption.weight(.semibold))
          }
        }
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .foregroundStyle(ADEColor.accent)
      .disabled(!enabled)
      .accessibilityLabel(
        restoring
          ? "Restoring cancelled queue"
          : (enabled ? "Undo queue cancellation" : "Queue restoration unavailable")
      )
      .accessibilityHint("Restores the cancelled messages to Claude’s queue")
    }
    .padding(.leading, 12)
    .padding(.trailing, 4)
    .background(ADEColor.warning.opacity(0.07), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .stroke(ADEColor.warning.opacity(0.18), lineWidth: 1)
    }
  }
}

private struct WorkContextUsageMeter: View {
  let usage: WorkContextUsageViewModel
  let active: Bool
  @Binding var isPresented: Bool

  private var percent: Int? {
    guard usage.state == .measured else { return nil }
    return usage.ratio.map { Int(($0 * 100).rounded()) }
  }

  private var ringColor: Color {
    guard let ratio = usage.ratio else { return ADEColor.textSecondary }
    if ratio >= 0.9 { return ADEColor.danger }
    if ratio >= 0.7 { return ADEColor.warning }
    return Color(red: 0.22, green: 0.74, blue: 0.97)
  }

  private var accessibilityLabel: String {
    switch usage.state {
    case .compacting:
      return "Context usage: compacting"
    case .recalculating:
      return "Context usage: recalculating"
    case .unknown:
      return "Context usage unavailable"
    case .measured:
      return percent.map { "Context usage: \($0)% full" } ?? "Context usage"
    }
  }

  var body: some View {
    if usage.ratio != nil || usage.usedTokens != nil {
      Button {
        withAnimation(.easeInOut(duration: 0.18)) {
          isPresented.toggle()
        }
      } label: {
        ZStack {
          if usage.state != .measured {
            Circle()
              .stroke(Color.white.opacity(0.12), lineWidth: 1.5)
              .frame(width: 22, height: 22)
            Text(usage.state == .unknown ? "?" : "…")
              .font(.system(size: 10, weight: .semibold, design: .rounded))
              .foregroundStyle(ADEColor.textSecondary)
          } else if let ratio = usage.ratio, let percent {
            Circle()
              .stroke(Color.white.opacity(0.10), lineWidth: 2.5)
              .frame(width: 22, height: 22)

            Circle()
              .trim(from: 0, to: CGFloat(ratio))
              .stroke(ringColor, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
              .rotationEffect(.degrees(-90))
              .frame(width: 22, height: 22)

            Text("\(percent)")
              .font(.system(size: percent >= 100 ? 7 : 8, weight: .semibold, design: .rounded))
              .monospacedDigit()
              .foregroundStyle(ADEColor.textPrimary.opacity(0.78))
              .minimumScaleFactor(0.65)
          } else if let usedTokens = usage.usedTokens {
            Text(workAbbreviateCount(usedTokens))
              .font(.system(size: 10, weight: .semibold, design: .rounded))
              .monospacedDigit()
              .foregroundStyle(ADEColor.textSecondary)
              .minimumScaleFactor(0.7)
          }
        }
        .frame(width: 28, height: 28)
        .contentShape(Rectangle())
        .opacity(active ? 1 : 0.92)
      }
      .buttonStyle(.plain)
      .accessibilityLabel(accessibilityLabel)
      .accessibilityHint(isPresented ? "Dismisses context usage details" : "Shows context usage details")
      .adeInspectable(
        "Work.Chat.Composer.ContextUsageMeter",
        metadata: [
          "label": percent.map { "Context usage: \($0)% full" } ?? "Context usage",
          "role": "button"
        ]
      )
    }
  }
}

private struct WorkContextUsagePopover: View {
  let usage: WorkContextUsageViewModel
  let modelLabel: String?

  private var percent: Int? {
    guard usage.state == .measured else { return nil }
    return usage.ratio.map { Int(($0 * 100).rounded()) }
  }

  private var windowLabel: String? {
    usage.contextWindow.map { workAbbreviateCount($0) }
  }

  private var usedLabel: String? {
    usage.usedTokens.map { workAbbreviateCount($0) }
  }

  private var description: String {
    if usage.state == .compacting {
      return "Claude is compacting this chat. The previous exact reading is temporarily hidden."
    }
    if usage.state == .recalculating {
      return "Compaction finished. ADE is waiting for the next authoritative usage snapshot."
    }
    if usage.state == .unknown {
      return "The runtime did not return an authoritative context reading."
    }
    let model = modelLabel?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let percent, let windowLabel {
      let owner: String
      if let model, !model.isEmpty {
        owner = "\(model)'s "
      } else {
        owner = "the "
      }
      let estimated = usage.windowSource == .registry ? " (estimated)" : ""
      return "Using \(percent)% of \(owner)\(windowLabel)-token context window\(estimated)."
    }
    let used = usedLabel ?? "--"
    if let model, !model.isEmpty {
      return "\(used) tokens used so far by \(model); context window unknown."
    }
    return "\(used) tokens used so far; context window unknown."
  }

  private var breakdown: String? {
    guard usage.state == .measured else { return nil }
    var segments: [String] = []
    if let value = usage.inputTokens { segments.append("in \(workAbbreviateCount(value))") }
    if let value = usage.outputTokens { segments.append("out \(workAbbreviateCount(value))") }
    if let value = usage.cacheReadTokens { segments.append("cached \(workAbbreviateCount(value)) *") }
    if let value = usage.reasoningTokens { segments.append("reasoning \(workAbbreviateCount(value))") }
    return segments.isEmpty ? nil : segments.joined(separator: " · ")
  }

  private var effect: String? {
    guard let percent, let windowLabel else { return nil }
    return "\(usedLabel ?? "--") / \(windowLabel) tokens · \(percent)% full"
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      Text("Context usage")
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)

      Text(description)
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)

      if breakdown != nil || effect != nil {
        Rectangle()
          .fill(ADEColor.border.opacity(0.35))
          .frame(height: 1)
      }

      if let breakdown {
        Text(breakdown)
          .font(.caption.monospaced())
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(2)
          .fixedSize(horizontal: false, vertical: true)
      }

      if let effect {
        Text(effect)
          .font(.caption.monospacedDigit())
          .foregroundStyle((usage.ratio ?? 0) >= 0.8 ? ADEColor.warning : ADEColor.success)
          .lineLimit(1)
          .minimumScaleFactor(0.7)
      }

      if usage.state == .measured, let ratio = usage.ratio, ratio >= 0.8 {
        Text("Nearing the limit; older context may be auto-trimmed or compacted.")
          .font(.caption2)
          .foregroundStyle(ADEColor.warning)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .background(ADEColor.surfaceBackground.opacity(0.94), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .stroke(ADEColor.glassBorder.opacity(0.9), lineWidth: 1)
    )
    .shadow(color: Color.black.opacity(0.10), radius: 3, y: 1)
    .accessibilityIdentifier("Work.Chat.Composer.ContextUsagePopover")
  }
}

struct WorkChatComposerDraftRestore: Equatable, Identifiable {
  let id: UUID
  let text: String
  let replacesExistingDraft: Bool

  init(
    text: String,
    id: UUID = UUID(),
    replacesExistingDraft: Bool = false
  ) {
    self.id = id
    self.text = text
    self.replacesExistingDraft = replacesExistingDraft
  }
}

final class WorkChatComposerDraftState: ObservableObject {
  @Published var text = "" {
    didSet {
      guard text != oldValue else { return }
      scheduleAutosave()
    }
  }
  @Published var isFocused = false
  private var appliedRestoreId: UUID?
  /// Surface this composer's draft is persisted under. Empty means "don't
  /// persist" (the key is unresolved), which is the safe default.
  private var persistenceKey = ""
  private var autosaveTask: Task<Void, Never>?

  var trimmedText: String {
    text.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// Point this composer at a chat's stored draft. The composer view is reused
  /// across session switches, so the outgoing chat's text is flushed under its
  /// own key before the new one is loaded — otherwise switching chats would
  /// either lose a draft or write it into the wrong conversation.
  @MainActor
  func bind(persistenceKey key: String) {
    guard persistenceKey != key else { return }
    // A blank previous key means this is the first bind of a freshly mounted
    // composer; anything else is the view being reused for a different chat.
    let isFirstBind = persistenceKey.isEmpty
    flushDraft()
    persistenceKey = key
    let stored = key.isEmpty ? "" : WorkComposerDraftStore.load(key)

    guard !isFirstBind else {
      // First mount: whatever is already in the field wins. A failed send
      // restores its text here, and that is fresher than anything on disk.
      guard trimmedText.isEmpty, !stored.isEmpty else { return }
      text = stored
      return
    }

    // Session switch: the visible text belongs to the chat we just left, and it
    // has already been flushed under that chat's key. It must NOT survive into
    // this one — leaving it would show one conversation's draft in another,
    // autosave it over the destination's own stored draft on the next
    // keystroke, and put the wrong message one tap from being sent.
    if text != stored {
      text = stored
    }
  }

  /// Write the draft now, cancelling any pending debounce. Called when the chat
  /// is torn down — the case the debounce would otherwise miss.
  @MainActor
  func flushDraft() {
    autosaveTask?.cancel()
    autosaveTask = nil
    guard !persistenceKey.isEmpty else { return }
    WorkComposerDraftStore.save(text, for: persistenceKey)
  }

  /// Keystroke debounce: each edit restarts the timer, so a burst of typing
  /// costs one write instead of one per character.
  private func scheduleAutosave() {
    guard !persistenceKey.isEmpty else { return }
    autosaveTask?.cancel()
    let key = persistenceKey
    let value = text
    autosaveTask = Task { @MainActor in
      try? await Task.sleep(for: workDraftAutosaveDebounce)
      guard !Task.isCancelled else { return }
      WorkComposerDraftStore.save(value, for: key)
    }
  }

  var hasSendableText: Bool {
    !trimmedText.isEmpty
  }

  func consumeSendableText() -> String {
    let value = trimmedText
    isFocused = false
    text = ""
    // Drop the stored copy synchronously rather than letting the 400ms debounce
    // get to it. A jetsam or force-quit inside that window would otherwise
    // restore an already-sent message into the composer, where it reads as
    // unsent and invites sending it twice. The Hub and New Chat composers clear
    // on send for the same reason.
    clearStoredDraft()
    return value
  }

  /// Cancels any pending autosave and removes the persisted draft. Not
  /// actor-annotated so `consumeSendableText()` — which runs from the send
  /// button's synchronous action — can call it directly.
  func clearStoredDraft() {
    autosaveTask?.cancel()
    autosaveTask = nil
    guard !persistenceKey.isEmpty else { return }
    WorkComposerDraftStore.clear(persistenceKey)
  }

  func restoreUnsentText(_ value: String) {
    let currentDraft = trimmedText
    if currentDraft != value {
      if currentDraft.isEmpty {
        text = value
      } else {
        text = "\(value)\n\(text)"
      }
    }
    isFocused = true
  }

  func applyRestore(_ restore: WorkChatComposerDraftRestore?) {
    guard let restore, appliedRestoreId != restore.id else { return }
    appliedRestoreId = restore.id
    if restore.replacesExistingDraft {
      text = restore.text
      isFocused = true
    } else {
      restoreUnsentText(restore.text)
    }
  }
}

private struct WorkChatComposerTextField: View {
  @ObservedObject var draftState: WorkChatComposerDraftState
  @ObservedObject var controller: WorkComposerSuggestionController
  let canCompose: Bool
  let placeholder: String
  var acceptsPastedImages = true
  var onPasteImages: (([UIImage]) -> Void)? = nil
  var maxLines = 6
  @State private var measuredHeight: CGFloat = 24

  var body: some View {
    WorkComposerTextView(
      draftState: draftState,
      controller: controller,
      canCompose: canCompose,
      placeholder: placeholder,
      measuredHeight: $measuredHeight,
      acceptsPastedImages: acceptsPastedImages,
      onPasteImages: onPasteImages,
      maxLines: maxLines
    )
    .frame(height: measuredHeight)
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

private struct WorkChatComposerSendButton: View {
  @ObservedObject var draftState: WorkChatComposerDraftState
  @Binding var attachments: [WorkChatInputAttachment]
  let canSend: Bool
  let canUploadAttachments: Bool
  let sending: Bool
  var accessibilityLabelText = "Send message"
  var systemImageName = "arrow.up"
  var minimumTapTargetSize: CGFloat = 28
  let onSend: @MainActor (String, [WorkChatInputAttachment]) async -> Bool
  let onSent: () -> Void

  private var sendEnabled: Bool {
    workChatInputCanSend(
      text: draftState.text,
      attachments: attachments,
      baseEnabled: canSend,
      canUploadAttachments: canUploadAttachments
    )
  }

  var body: some View {
    ADEComposerSendButton(
      enabled: sendEnabled,
      sending: sending,
      accessibilityLabelText: accessibilityLabelText,
      systemImageName: systemImageName,
      minimumTapTargetSize: minimumTapTargetSize
    ) {
      let originalText = draftState.consumeSendableText()
      let outgoingAttachments = workChatInputReadyAttachments(attachments)
      let text = workChatOutgoingText(originalText, attachmentCount: outgoingAttachments.count)
      let restoredAttachments = attachments
      attachments.removeAll()
      Task { @MainActor in
        let sent = await onSend(text, outgoingAttachments)
        if sent {
          onSent()
        } else {
          attachments = restoredAttachments
          draftState.restoreUnsentText(originalText)
        }
      }
    }
    .adeInspectable(
      "Work.Chat.Composer.SendButton",
      metadata: [
        "label": sending ? "Sending message" : accessibilityLabelText,
        "role": "button"
      ]
    )
  }
}
