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
  @State var timelineIncrementalCache = WorkTimelineIncrementalCache()
  @State var timelineSourceKey: String?
  @State var timelineRebuildTask: Task<Void, Never>?
  @State var timelineRebuildPending = false
  @State var timelineRebuildGeneration = 0
  @State var timelineBuildScopeId = UUID().uuidString
  @State var latestPinTask: Task<Void, Never>?
  @State var latestPinGeneration = 0
  @State var assistantPreviewCache = WorkAssistantPreviewCache()
  @State var assistantLineBudgets: [String: Int] = [:]
  @State var composerSettingMutationInFlight = false
  @State var composerSettingMutationGeneration = 0
  @State var pendingCodexFastMode: Bool?
  @State var scrollStateSessionId: String?
  @State var pendingInitialBottomPinSessionId: String?
  @State var timelineLayoutPinToken = 0
  let isLive: Bool
  let hostUnreachable: Bool
  let canComposeMessages: Bool
  let canSendMessages: Bool
  let sendWillQueue: Bool
  let sendWillQueueIsReconnect: Bool
  var inputLockMessage: String? = nil
  let transitionNamespace: Namespace.ID?
  let onOpenLane: (() -> Void)?
  let onSend: @MainActor (String, [WorkChatInputAttachment]) async -> Bool
  let onInterrupt: @MainActor () async -> Void
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
  var onLoadOlderTranscript: (@MainActor () async -> Void)? = nil
  var subagentSnapshots: [WorkSubagentSnapshot] = []
  var subagentSnapshotsRenderSignature: Int = 0
  var scheduledWorkSnapshots: [WorkScheduledWorkSnapshot] = []
  var scheduledWorkSnapshotsRenderSignature: Int = 0
  var selectedSubagentTaskId: String? = nil
  var onOpenChatInfo: (() -> Void)? = nil
  var onOpenSubagents: (() -> Void)? = nil
  var prBadge: WorkChatPrBadgeModel? = nil
  var onOpenPrDetails: (() -> Void)? = nil
  /// Live "turn is running" signal from the sync layer (chat_subscribe ack +
  /// live status/done events). Covers the gap where the synced session row
  /// still says idle while chat events are already streaming — without it
  /// the chat renders output with no stop button or working indicator.
  var liveTurnActiveHint: Bool? = nil

  @State var steerEditDrafts: [String: String] = [:]
  @State var modelPickerPresented = false
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

  @MainActor
  func refreshTimelinePresentation(sourceTimeline: [WorkTimelineEntry]? = nil) {
    let timeline = sourceTimeline ?? timelineSnapshot.timeline
    var nextPresentation = makeWorkTimelinePresentation(
      timeline: timeline,
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
      visibleTimelineCount += timelineDelta
      nextPresentation = makeWorkTimelinePresentation(
        timeline: timeline,
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
    if !canSendMessages {
      return "Reconnect to send messages."
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
    if let errorMessage, !hostUnreachable {
      ADENoticeCard(
        title: "Chat error",
        message: errorMessage,
        icon: "exclamationmark.triangle.fill",
        tint: ADEColor.danger,
        actionTitle: "Retry",
        action: { Task { await onRetryLoad() } }
      )
    }
  }

  @ViewBuilder
  func timelineSection(proxy: ScrollViewProxy) -> some View {
    if timeline.isEmpty {
      ADEEmptyStateView(
        symbol: "bubble.left.and.bubble.right",
        title: selectedSubagentTaskId == nil ? "No chat messages yet" : "No subagent transcript",
        message: selectedSubagentTaskId == nil
          ? (isLive ? "Send a message to start streaming the transcript." : "Reconnect to load the latest chat history from the machine.")
          : "This subagent did not publish detailed transcript output."
      )
    } else {
      if hiddenTimelineCount > 0 || hasOlderTranscriptHistory {
        let nextPageCount = min(hiddenTimelineCount, workTimelinePageSize)
        let loadEarlierTitle = nextPageCount > 0
          ? "Load \(nextPageCount) earlier message\(nextPageCount == 1 ? "" : "s")"
          : "Load earlier messages"
        Button {
          loadEarlierTimelineEntries()
        } label: {
          Label(loadEarlierTitle, systemImage: "chevron.up.circle")
          .font(.footnote.weight(.semibold))
          .foregroundStyle(ADEColor.accent)
          .frame(maxWidth: .infinity)
          .padding(.vertical, 8)
          .background(ADEColor.cardBackground.opacity(0.4), in: Capsule(style: .continuous))
          .overlay(
            Capsule(style: .continuous)
              .stroke(ADEColor.glassBorder, lineWidth: 1)
          )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Load earlier messages")
      }

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

  @ViewBuilder
  var streamingStatusSection: some View {
    if isStreamingTurn {
      WorkActivityIndicator(
        transcript: transcript,
        isStreaming: true
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
      let runningSubagentCount = workSubagentRunningCount(subagentSnapshots)
      let activeScheduledWorkCount = workScheduledWorkActiveCount(scheduledWorkSnapshots)
      let showsChatInfoBadge = inputLockMessage == nil && activeScheduledWorkCount > 0 && onOpenChatInfo != nil
      let showsSubagentBadge = inputLockMessage == nil && runningSubagentCount > 0 && onOpenSubagents != nil
      let showsPrBadge = inputLockMessage == nil && prBadge != nil && onOpenPrDetails != nil
      if showsChatInfoBadge || showsSubagentBadge || showsPrBadge {
        HStack(spacing: 8) {
          if showsChatInfoBadge, let onOpenChatInfo {
            WorkChatInfoActivePopup(count: activeScheduledWorkCount, onOpen: onOpenChatInfo)
          }
          if showsSubagentBadge, let onOpenSubagents {
            WorkSubagentActivePopup(count: runningSubagentCount, onOpen: onOpenSubagents)
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

      WorkChatComposerCard(
        chatSummary: chatSummaryContext,
        usageViewModel: workContextUsageViewModel(
          transcript: transcript,
          provider: chatSummaryContext.provider,
          fallbackContextWindow: chatSummaryContext.contextWindowFallback
        ),
        laneId: session.laneId,
        dictationTargetId: "work-chat:\(session.id)",
        awaitingInputGate: hasPendingInputGate,
        composerPlaceholder: composerPlaceholderText,
        canCompose: canCompose,
        canSend: canSend && !composerSettingMutationInFlight,
        sending: sending && !sendWillQueue,
        settingsMutationInFlight: composerSettingMutationInFlight,
        codexFastModeOverride: pendingCodexFastMode,
        // Show Stop while a live turn has current transcript activity. The
        // broader live hint can lag after `done`; this stricter gate keeps the
        // composer from showing Stop after the completed-turn separator appears.
        showInterrupt: shouldShowInterruptControl,
        interruptInFlight: actionInFlight,
        onInterrupt: {
          await runSessionAction(onInterrupt)
        },
        onOpenModelPicker: !chatSummaryContext.isAvailable ? nil : { modelPickerPresented = true },
        onSelectRuntimeMode: !chatSummaryContext.isAvailable ? nil : { mode in
          runComposerSettingMutation {
            await onSelectRuntimeMode(mode)
          }
        },
        onToggleCodexFastMode: !chatSummaryContext.isAvailable ? nil : { enabled in
          pendingCodexFastMode = enabled
          runComposerSettingMutation(onFailure: {
            pendingCodexFastMode = nil
          }) {
            await onSelectCodexFastMode(enabled)
          }
        },
        onSend: onSend,
        onSent: {
          scrollToLatest(proxy, animated: true)
        }
      )
    }
    .padding(.horizontal, 16)
    .padding(.top, 4)
    .padding(.bottom, 0)
  }

  var body: some View {
    ScrollViewReader { proxy in
      VStack(spacing: 0) {
        ScrollView {
          VStack(alignment: .leading, spacing: 14) {
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
              requestedCwd: chatSummaryContext.requestedCwd
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
          resolvePendingInitialBottomPinAfterLayout(proxy, reason: "content-bottom")
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
          assistantLineBudgets.removeAll()
          composerSettingMutationInFlight = false
          composerSettingMutationGeneration &+= 1
          resetScrollStateForCurrentSession(reason: "session-change")
          cancelScheduledTimelineSnapshotRebuild()
          timelineSnapshot = .empty
          timelinePresentation = .empty
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
            isBusy: modelUpdateInFlight,
            onSelect: { option, pickedReasoning, _ in
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
                modelPickerPresented = false
              }
            }
          )
        }
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
    let tailCanRenderFull = previewAnchor == .tail
      && !workAssistantMessageUsesMonospacedPreview(message.markdown)
      && workAssistantMessageLineCount(message.markdown) <= workAssistantMessageTailFullLineBudget
      && message.markdown.count <= workAssistantMessageTailFullCharacterBudget
    let lineBudget = assistantLineBudgets[message.id]
      ?? (tailCanRenderFull ? workAssistantMessageTailFullLineBudget : workAssistantMessageInitialLineBudget)
    let characterBudget = workAssistantMessageCharacterBudget(
      forLineBudget: lineBudget,
      tailCanRenderFull: tailCanRenderFull && assistantLineBudgets[message.id] == nil
    )
    if lineBudget == workAssistantMessageInitialLineBudget {
      message.assistantPreview = cache.preview(for: message, anchor: previewAnchor)
    } else {
      message.assistantPreview = workAssistantMessagePreview(
        message.markdown,
        lineBudget: lineBudget,
        characterBudget: characterBudget,
        anchor: previewAnchor
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
    let maxLineBudget = workAssistantMessageMaxLineBudget(for: message.markdown)
    let nextLineBudget = min(requestedLineBudget + workAssistantMessageLineBudgetStep, maxLineBudget)
    let accessibilityLabel = workAssistantMessageAccessibilityLabel(preview)

    if workAssistantMessageUsesMonospacedPreview(preview.text) {
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
        canShowMore: requestedLineBudget < maxLineBudget,
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
  let sending: Bool
  let settingsMutationInFlight: Bool
  let codexFastModeOverride: Bool?
  /// True while the assistant is streaming a response. Swaps the Send button
  /// Desktop parity: red bordered stop control in the composer while a turn is
  /// active (`border-red-500/25 bg-red-500/[0.08] text-red-400/80`).
  /// old full-width yellow slab that used to sit under the header.
  let showInterrupt: Bool
  let interruptInFlight: Bool
  let onInterrupt: @MainActor () async -> Void
  let onOpenModelPicker: (() -> Void)?
  let onSelectRuntimeMode: ((String) -> Void)?
  let onToggleCodexFastMode: ((Bool) -> Void)?
  let onSend: @MainActor (String, [WorkChatInputAttachment]) async -> Bool
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
      sending: sending,
      settingsMutationInFlight: settingsMutationInFlight,
      codexFastModeOverride: codexFastModeOverride,
      showInterrupt: showInterrupt,
      interruptInFlight: interruptInFlight,
      onInterrupt: onInterrupt,
      onOpenModelPicker: onOpenModelPicker,
      onSelectRuntimeMode: onSelectRuntimeMode,
      onToggleCodexFastMode: onToggleCodexFastMode,
      onSend: onSend,
      onSent: onSent
    )
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
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
  let sending: Bool
  let settingsMutationInFlight: Bool
  let codexFastModeOverride: Bool?
  let showInterrupt: Bool
  let interruptInFlight: Bool
  let onInterrupt: @MainActor () async -> Void
  let onOpenModelPicker: (() -> Void)?
  let onSelectRuntimeMode: ((String) -> Void)?
  let onToggleCodexFastMode: ((Bool) -> Void)?
  let onSend: @MainActor (String, [WorkChatInputAttachment]) async -> Bool
  let onSent: () -> Void

  @EnvironmentObject private var syncService: SyncService
  @StateObject private var draftState = WorkChatComposerDraftState()
  @StateObject private var suggestionController = WorkComposerSuggestionController()
  @State private var contextUsagePresented = false
  @StateObject private var dictationCoordinator = DictationInsertionCoordinator()
  @State private var isDictating = false
  @State private var inputAttachments: [WorkChatInputAttachment] = []

  private var hasSendableDraftOrAttachment: Bool {
    draftState.hasSendableText || !workChatInputReadyAttachments(inputAttachments).isEmpty
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      WorkComposerSuggestionStrip(controller: suggestionController)
        .animation(.smooth(duration: 0.16), value: suggestionController.isVisible)

      WorkChatInputAttachmentTray(attachments: $inputAttachments)

      WorkChatComposerTextField(
        draftState: draftState,
        controller: suggestionController,
        canCompose: canCompose,
        placeholder: composerPlaceholder,
        onPasteImages: { images in
          workChatInputPasteImages(images, into: $inputAttachments)
        }
      )

      if showInterrupt && hasSendableDraftOrAttachment {
        Text("Message will stage behind the active turn.")
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
            attachments: $inputAttachments,
            disabled: !canCompose || settingsMutationInFlight
          )

          WorkComposerChipStrip(
            chatSummary: chatSummary,
            settingsMutationInFlight: settingsMutationInFlight,
            codexFastModeOverride: codexFastModeOverride,
            onOpenModelPicker: onOpenModelPicker,
            onSelectRuntimeMode: onSelectRuntimeMode,
            onToggleCodexFastMode: onToggleCodexFastMode
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
          if showInterrupt {
            if hasSendableDraftOrAttachment {
              stopButton()
              WorkChatComposerSendButton(
                draftState: draftState,
                attachments: $inputAttachments,
                canSend: canSend,
                sending: sending,
                accessibilityLabelText: "Stage message",
                onSend: onSend,
                onSent: onSent
              )
            } else {
              stopButton()
            }
          } else {
            WorkChatComposerSendButton(
              draftState: draftState,
              attachments: $inputAttachments,
              canSend: canSend,
              sending: sending,
              onSend: onSend,
              onSent: onSent
            )
          }
        }
      }
    }
    .onChange(of: usageViewModel) { _, newValue in
      if newValue == nil {
        contextUsagePresented = false
      }
    }
    .onAppear { configureSuggestionController() }
    .onChange(of: chatSummary.provider) { _, _ in configureSuggestionController() }
    .onChange(of: laneId) { _, _ in configureSuggestionController() }
  }

  private func configureSuggestionController() {
    suggestionController.provider = chatSummary.provider
    suggestionController.laneId = laneId.isEmpty ? nil : laneId
    suggestionController.syncService = syncService
  }

  @ViewBuilder
  private func stopButton() -> some View {
    Button {
      Task { await onInterrupt() }
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
    .adeInspectable(
      "Work.Chat.Composer.StopButton",
      metadata: [
        "label": interruptInFlight ? "Interrupting turn" : "Stop turn",
        "role": "button"
      ]
    )
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
}

private struct WorkContextUsageMeter: View {
  let usage: WorkContextUsageViewModel
  let active: Bool
  @Binding var isPresented: Bool

  private var percent: Int? {
    usage.ratio.map { Int(($0 * 100).rounded()) }
  }

  private var ringColor: Color {
    guard let ratio = usage.ratio else { return ADEColor.textSecondary }
    if ratio >= 0.9 { return ADEColor.danger }
    if ratio >= 0.7 { return ADEColor.warning }
    return Color(red: 0.22, green: 0.74, blue: 0.97)
  }

  var body: some View {
    if usage.ratio != nil || usage.usedTokens != nil {
      Button {
        withAnimation(.easeInOut(duration: 0.18)) {
          isPresented.toggle()
        }
      } label: {
        ZStack {
          if let ratio = usage.ratio, let percent {
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
      .accessibilityLabel(percent.map { "Context usage: \($0)% full" } ?? "Context usage")
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
    usage.ratio.map { Int(($0 * 100).rounded()) }
  }

  private var windowLabel: String? {
    usage.contextWindow.map { workAbbreviateCount($0) }
  }

  private var usedLabel: String? {
    usage.usedTokens.map { workAbbreviateCount($0) }
  }

  private var description: String {
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

      if let ratio = usage.ratio, ratio >= 0.8 {
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

final class WorkChatComposerDraftState: ObservableObject {
  @Published var text = ""

  var trimmedText: String {
    text.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  var hasSendableText: Bool {
    !trimmedText.isEmpty
  }

  func consumeSendableText() -> String {
    let value = trimmedText
    text = ""
    return value
  }

  func restoreUnsentText(_ value: String) {
    let currentDraft = trimmedText
    guard currentDraft != value else { return }
    if currentDraft.isEmpty {
      text = value
    } else {
      text = "\(value)\n\(text)"
    }
  }
}

private struct WorkChatComposerTextField: View {
  @ObservedObject var draftState: WorkChatComposerDraftState
  @ObservedObject var controller: WorkComposerSuggestionController
  let canCompose: Bool
  let placeholder: String
  var onPasteImages: (([UIImage]) -> Void)? = nil
  @State private var measuredHeight: CGFloat = 24

  var body: some View {
    WorkComposerTextView(
      draftState: draftState,
      controller: controller,
      canCompose: canCompose,
      placeholder: placeholder,
      measuredHeight: $measuredHeight,
      onPasteImages: onPasteImages
    )
    .frame(height: measuredHeight)
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

private struct WorkChatComposerSendButton: View {
  @ObservedObject var draftState: WorkChatComposerDraftState
  @Binding var attachments: [WorkChatInputAttachment]
  let canSend: Bool
  let sending: Bool
  var accessibilityLabelText = "Send message"
  let onSend: @MainActor (String, [WorkChatInputAttachment]) async -> Bool
  let onSent: () -> Void

  private var sendEnabled: Bool {
    canSend
      && !workChatInputHasLoadingAttachments(attachments)
      && (draftState.hasSendableText || !workChatInputReadyAttachments(attachments).isEmpty)
  }

  var body: some View {
    ADEComposerSendButton(
      enabled: sendEnabled,
      sending: sending,
      accessibilityLabelText: accessibilityLabelText
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
          draftState.restoreUnsentText(originalText)
          attachments = restoredAttachments
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
