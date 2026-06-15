import SwiftUI
import UIKit
import AVKit
import OSLog

let workChatScrollLog = Logger(subsystem: "com.ade.ios", category: "WorkChatScroll")
let workChatScrollCoordinateSpace = "WorkChatScrollCoordinateSpace"
let workChatStickThreshold: CGFloat = 160
let workChatStickResumeThreshold: CGFloat = 24
let workChatTouchScrollDeadband: CGFloat = 2

struct WorkChatSessionView: View {
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  @EnvironmentObject private var syncService: SyncService

  let session: TerminalSessionSummary
  let chatSummary: AgentChatSessionSummary?
  let transcript: [WorkChatEnvelope]
  let fallbackEntries: [AgentChatTranscriptEntry]
  let artifacts: [ComputerUseArtifactSummary]
  let optimisticPendingSteers: [WorkPendingSteerModel]
  let localEchoMessages: [WorkLocalEchoMessage]
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
  @State var lastScrollDistanceFromBottom: CGFloat = 0
  @State var timelineDragActive = false
  @State var timelineSnapshot = WorkChatTimelineSnapshot.empty
  @State var timelinePresentation = WorkTimelinePresentation.empty
  @State var timelineRebuildTask: Task<Void, Never>?
  @State var timelineRebuildGeneration = 0
  @State var composerSettingMutationInFlight = false
  @State var composerSettingMutationGeneration = 0
  @State var pendingCodexFastMode: Bool?
  let isLive: Bool
  let canComposeMessages: Bool
  let canSendMessages: Bool
  let sendWillQueue: Bool
  let transitionNamespace: Namespace.ID?
  let onOpenLane: (() -> Void)?
  let onSend: @MainActor (String) async -> Bool
  let onInterrupt: @MainActor () async -> Void
  let onApproveRequest: @MainActor (String, AgentChatApprovalDecision) async -> Void
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

  var lanes: [LaneSummary] = []
  // Host-side scroll-back: true while older transcript pages remain on the
  // host beyond what the phone has fetched; the callback pulls the next page.
  var hasOlderTranscriptHistory: Bool = false
  var onLoadOlderTranscript: (@MainActor () async -> Void)? = nil
  /// Live "turn is running" signal from the sync layer (chat_subscribe ack +
  /// live status/done events). Covers the gap where the synced session row
  /// still says idle while chat events are already streaming — without it
  /// the chat renders output with no stop button or working indicator.
  var liveTurnActiveHint: Bool = false

  @State var steerEditDrafts: [String: String] = [:]
  @State var modelPickerPresented = false
  @State var modelUpdateInFlight = false

  var sessionStatus: String {
    normalizedWorkChatSessionStatus(session: session, summary: chatSummary)
  }

  /// Terminal transcript signal from the local event window. When present, it
  /// beats stale session rows / subscribe hints that can lag a just-finished
  /// turn by a few seconds.
  var transcriptLatestTurnEnded: Bool {
    workTranscriptLatestTurnEnded(transcript)
  }

  /// The live turn hint can be stale if mobile misses the final `done` event.
  /// When the synced row has an idle/end timestamp newer than our transcript
  /// tail, prefer the row so the working indicator clears promptly.
  var sessionRowEndedAfterLatestTranscript: Bool {
    guard sessionStatus == "idle" || sessionStatus == "ended" else { return false }
    let rowEndedAt = [
      chatSummary?.idleSinceAt,
      chatSummary?.endedAt,
      session.chatIdleSinceAt,
      session.endedAt
    ]
    .compactMap(workParsedDate)
    .max()
    guard let rowEndedAt else { return false }
    guard let latestTranscriptAt = transcript.compactMap({ workParsedDate($0.timestamp) }).max() else {
      return false
    }
    return rowEndedAt >= latestTranscriptAt.addingTimeInterval(-0.25)
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
    workChatShouldShowInterruptControl(isStreamingTurn: isStreamingTurn, transcript: transcript)
  }

  var pendingInputs: [WorkPendingInputItem] {
    timelineSnapshot.pendingInputs
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

  var hasPendingInputGate: Bool {
    workChatComposerBlocksFreeformInput(pendingInputCount: pendingInputs.count, sessionStatus: sessionStatus)
  }

  var awaitingPromptDetailsMissing: Bool {
    workChatAwaitingPromptDetailsMissing(pendingInputCount: pendingInputs.count, sessionStatus: sessionStatus)
  }

  var awaitingPromptDetailsMessage: String {
    let fallback = "The session is marked as needing input, but the prompt details have not synced to this iPhone yet. Keep the machine connected and try again when the prompt appears."
    guard let preview = awaitingPromptPreview else { return fallback }
    return "\(preview)\n\(fallback)"
  }

  private var awaitingPromptPreview: String? {
    [chatSummary?.lastOutputPreview, session.lastOutputPreview]
      .compactMap { value -> String? in
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
      }
      .first
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

  /// Timeline with synthetic turn-separator pills inserted before each new
  /// user-message turn. Cached alongside the visible slice so focus and
  /// keyboard layout changes do not rebuild transcript arrays.
  var timelineWithSeparators: [WorkTimelineEntry] {
    timelinePresentation.entries
  }

  var visibleTimeline: [WorkTimelineEntry] {
    timelinePresentation.visibleEntries
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
      chatSummary: chatSummary,
      transcript: transcript
    )
    if isNearBottom,
       timelinePresentation.hiddenCount > 0,
       nextPresentation.entries.count > timelinePresentation.entries.count {
      visibleTimelineCount += nextPresentation.entries.count - timelinePresentation.entries.count
      nextPresentation = makeWorkTimelinePresentation(
        timeline: timeline,
        visibleCount: visibleTimelineCount,
        chatSummary: chatSummary,
        transcript: transcript
      )
    }
    guard nextPresentation != timelinePresentation else { return }
    timelinePresentation = nextPresentation
    workChatScrollLog.notice(
      "presentation_update session=\(session.id, privacy: .public) timeline=\(timeline.count, privacy: .public) visible=\(nextPresentation.visibleEntries.count, privacy: .public) hidden=\(nextPresentation.hiddenCount, privacy: .public) firstVisible=\(nextPresentation.visibleEntries.first?.id ?? "none", privacy: .public) lastVisible=\(nextPresentation.visibleEntries.last?.id ?? "none", privacy: .public) tail=\(timeline.last?.id ?? "none", privacy: .public) limit=\(visibleTimelineCount, privacy: .public) nearBottom=\(isNearBottom, privacy: .public) unread=\(unreadBelowCount, privacy: .public)"
    )
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
    if sending && !sendWillQueue {
      return "Sending message to machine..."
    }
    if sendWillQueue, sessionStatus == "active" {
      return "Message will stage behind the active turn."
    }
    if sendWillQueue, pendingSteers.isEmpty {
      return "Machine is reconnecting. Send will queue until it is back."
    }
    if !canSendMessages {
      return "Reconnect to send messages."
    }
    if !pendingInputs.isEmpty {
      return "Answer the waiting prompt above, or decline it before sending another message."
    }
    if awaitingPromptDetailsMissing {
      return "Waiting for prompt details from the machine."
    }
    return nil
  }

  var jumpToLatestPillBottomPadding: CGFloat {
    // The pill is an overlay, so it needs to sit above the safe-area composer
    // instead of covering the Send/Stop control. Staged steers add a second
    // composer band, so give the pill extra air when that strip is present.
    if !pendingSteers.isEmpty { return 220 }
    if !pendingInputs.isEmpty { return 150 }
    return 116
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
    if isLive {
      ForEach(pendingInputs) { item in
        if case .approval(let approval) = item {
          WorkApprovalRequestCard(
            approval: approval,
            busy: actionInFlight,
            onDecision: { decision in
              await runSessionAction {
                await onApproveRequest(approval.id, decision)
              }
            }
          )
        }
      }
    }

    if awaitingPromptDetailsMissing {
      ADENoticeCard(
        title: "Prompt details syncing",
        message: awaitingPromptDetailsMessage,
        icon: "exclamationmark.bubble.fill",
        tint: ADEColor.warning,
        actionTitle: nil,
        action: nil
      )
    }

    // Connection-caused failures are communicated via the top-right gear, but
    // cached/offline chat actions still need their own visible errors.
    if let errorMessage, !syncService.connectionState.isHostUnreachable {
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
        title: "No chat messages yet",
        message: isLive ? "Send a message to start streaming the transcript." : "Reconnect to load the latest chat history from the machine."
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

      ForEach(visibleTimeline) { entry in
        timelineEntryView(for: entry, proxy: proxy)
      }
    }
  }

  var streamingStatusSection: some View {
    WorkActivityIndicator(
      transcript: transcript,
      isStreaming: isStreamingTurn
    )
  }

  /// Single desktop-shaped composer card: text field on top, chip strip and
  /// send button on the bottom, everything wrapped in one rounded container
  /// with clear contrast against the chat background.
  func composerInset(proxy: ScrollViewProxy) -> some View {
    VStack(spacing: 10) {
      // The redundant ENDED/RUNNING status pill row has been retired. Chat
      // lifecycle controls live outside the composer; this space is reserved
      // for pending input and send feedback.

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

      WorkChatComposerCard(
        chatSummary: chatSummary,
        usageViewModel: workContextUsageViewModel(transcript: transcript, summary: chatSummary),
        pendingInputCount: pendingInputs.count,
        awaitingInputGate: hasPendingInputGate,
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
        onOpenModelPicker: chatSummary == nil ? nil : { modelPickerPresented = true },
        onSelectRuntimeMode: chatSummary == nil ? nil : { mode in
          runComposerSettingMutation {
            await onSelectRuntimeMode(mode)
          }
        },
        onToggleCodexFastMode: chatSummary == nil ? nil : { enabled in
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
    .padding(.top, 8)
    .padding(.bottom, 0)
  }

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 14) {
          sessionOverviewSection
          if !timelineSnapshot.subagentSnapshots.isEmpty {
            WorkSubagentStrip(snapshots: timelineSnapshot.subagentSnapshots)
          }
          timelineSection(proxy: proxy)
          streamingStatusSection

          Color.clear
            .frame(height: 1)
            .id("chat-end")
            .background(
              GeometryReader { geometry in
                Color.clear.preference(
                  key: WorkChatContentBottomPreferenceKey.self,
                  value: geometry.frame(in: .named(workChatScrollCoordinateSpace)).maxY
                )
              }
            )
            .onAppear {
              workChatScrollLog.notice(
                "bottom_sentinel_appeared session=\(session.id, privacy: .public) timeline=\(timeline.count, privacy: .public) visible=\(visibleTimeline.count, privacy: .public) tail=\(timeline.last?.id ?? "none", privacy: .public) lastVisible=\(visibleTimeline.last?.id ?? "none", privacy: .public) unread=\(unreadBelowCount, privacy: .public) distance=\(lastScrollDistanceFromBottom, privacy: .public)"
              )
            }
            .onDisappear {
              workChatScrollLog.notice(
                "bottom_sentinel_disappeared session=\(session.id, privacy: .public) timeline=\(timeline.count, privacy: .public) visible=\(visibleTimeline.count, privacy: .public) tail=\(timeline.last?.id ?? "none", privacy: .public) lastVisible=\(visibleTimeline.last?.id ?? "none", privacy: .public) unread=\(unreadBelowCount, privacy: .public) distance=\(lastScrollDistanceFromBottom, privacy: .public)"
              )
            }
        }
        .padding(16)
        .modifier(
          WorkChatTranscriptEnvironmentModifier(
            provider: chatSummary?.provider,
            modelId: chatSummary?.modelId ?? chatSummary?.model,
            modelLabel: chatSummary.map { prettyWorkChatModelName($0.model) },
            laneId: session.laneId,
            requestedCwd: chatSummary?.requestedCwd
          )
        )
      }
      .scrollIndicators(.hidden)
      .scrollDismissesKeyboard(.interactively)
      .coordinateSpace(name: workChatScrollCoordinateSpace)
      .background(
        GeometryReader { geometry in
          Color.clear.preference(
            key: WorkChatViewportHeightPreferenceKey.self,
            value: geometry.size.height
          )
        }
      )
      .background(workChatCanvasBackground.ignoresSafeArea())
      .adeNavigationGlass()
      .simultaneousGesture(
        DragGesture(minimumDistance: 0)
          .onChanged { value in
            timelineDragActive = true
            if value.translation.height > workChatTouchScrollDeadband {
              releaseBottomStickinessForUserScroll(reason: "drag")
            }
          }
          .onEnded { _ in
            timelineDragActive = false
            updateBottomStickiness(distanceFromBottom: lastScrollDistanceFromBottom, proxy: proxy)
          }
      )
      .safeAreaInset(edge: .bottom, spacing: 0) {
        composerInset(proxy: proxy)
          .background(alignment: .bottom) {
            WorkChatComposerBackdrop()
          }
      }
      .overlay(alignment: .top) {
        WorkChatNavigationBackdrop()
      }
      .overlay(alignment: .bottomTrailing) {
        if unreadBelowCount > 0 || !isNearBottom {
          WorkJumpToLatestPill(count: unreadBelowCount) {
            workChatScrollLog.notice(
              "jump_to_latest_tapped session=\(session.id, privacy: .public) unread=\(unreadBelowCount, privacy: .public) timeline=\(timeline.count, privacy: .public) visible=\(visibleTimeline.count, privacy: .public) tail=\(timeline.last?.id ?? "none", privacy: .public) lastVisible=\(visibleTimeline.last?.id ?? "none", privacy: .public)"
            )
            isNearBottom = true
            timelineDragActive = false
            scrollToLatest(proxy, animated: true)
            unreadBelowCount = 0
          }
          .padding(.trailing, 16)
          .padding(.bottom, jumpToLatestPillBottomPadding)
          .transition(.move(edge: .trailing).combined(with: .opacity))
        }
      }
      .onPreferenceChange(WorkChatViewportHeightPreferenceKey.self) { height in
        scrollViewportHeight = height
      }
      .onPreferenceChange(WorkChatContentBottomPreferenceKey.self) { bottomY in
        guard scrollViewportHeight > 1 else { return }
        updateBottomStickiness(
          distanceFromBottom: max(0, bottomY - scrollViewportHeight),
          proxy: proxy
        )
      }
      .onChange(of: timeline.count) { oldCount, newCount in
        let previousTailId = lastTimelineTailId
        lastTimelineTailId = timeline.last?.id
        let delta = newCount - oldCount
        guard delta > 0 else {
          workChatScrollLog.notice(
            "timeline_count_changed_no_growth session=\(session.id, privacy: .public) old=\(oldCount, privacy: .public) new=\(newCount, privacy: .public) tail=\(timeline.last?.id ?? "none", privacy: .public) previousTail=\(previousTailId ?? "none", privacy: .public) nearBottom=\(isNearBottom, privacy: .public) unread=\(unreadBelowCount, privacy: .public)"
          )
          return
        }
        // Older-page prepends grow the timeline above the viewport — the
        // newest entry stays put. Don't autoscroll to the bottom or flag
        // the prepended entries as "new messages below".
        if let previousTailId, previousTailId == timeline.last?.id {
          workChatScrollLog.notice(
            "timeline_growth_skipped_prepended session=\(session.id, privacy: .public) old=\(oldCount, privacy: .public) new=\(newCount, privacy: .public) delta=\(delta, privacy: .public) tail=\(timeline.last?.id ?? "none", privacy: .public) nearBottom=\(isNearBottom, privacy: .public) unread=\(unreadBelowCount, privacy: .public)"
          )
          return
        }
        if isNearBottom {
          workChatScrollLog.notice(
            "timeline_growth_autoscroll session=\(session.id, privacy: .public) old=\(oldCount, privacy: .public) new=\(newCount, privacy: .public) delta=\(delta, privacy: .public) tail=\(timeline.last?.id ?? "none", privacy: .public) previousTail=\(previousTailId ?? "none", privacy: .public)"
          )
          pinToLatestAfterLayout(proxy, reason: "timeline-growth")
        } else {
          let nextCount = unreadBelowCount + delta
          workChatScrollLog.notice(
            "timeline_growth_unread session=\(session.id, privacy: .public) old=\(oldCount, privacy: .public) new=\(newCount, privacy: .public) delta=\(delta, privacy: .public) tail=\(timeline.last?.id ?? "none", privacy: .public) unread=\(nextCount, privacy: .public)"
          )
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
        workChatScrollLog.notice(
          "timeline_tail_changed session=\(session.id, privacy: .public) oldTail=\(oldTailId ?? "none", privacy: .public) newTail=\(newTailId ?? "none", privacy: .public) timeline=\(timeline.count, privacy: .public) visible=\(visibleTimeline.count, privacy: .public) lastVisible=\(visibleTimeline.last?.id ?? "none", privacy: .public) nearBottom=\(isNearBottom, privacy: .public) unread=\(unreadBelowCount, privacy: .public)"
        )
        lastTimelineTailId = newTailId
        guard oldTailId != nil, newTailId != nil, isNearBottom else { return }
        pinToLatestAfterLayout(proxy, reason: "timeline-tail")
      }
      .onChange(of: isNearBottom) { _, nearBottom in
        guard nearBottom, unreadBelowCount > 0 else { return }
        workChatScrollLog.notice(
          "near_bottom_clears_unread session=\(session.id, privacy: .public) unread=\(unreadBelowCount, privacy: .public) timeline=\(timeline.count, privacy: .public) tail=\(timeline.last?.id ?? "none", privacy: .public)"
        )
        withAnimation(ADEMotion.quick(reduceMotion: reduceMotion)) {
          unreadBelowCount = 0
        }
      }
      .onAppear {
        refreshTimelinePresentation()
        scheduleTimelineSnapshotRebuild()
      }
      .onDisappear {
        cancelScheduledTimelineSnapshotRebuild()
      }
      .onChange(of: chatSummary) { _, _ in
        refreshTimelinePresentation()
      }
      .onChange(of: chatSummary?.codexFastMode) { _, newValue in
        if let pendingCodexFastMode, pendingCodexFastMode == (newValue == true) {
          self.pendingCodexFastMode = nil
        }
      }
      .onChange(of: session.id) { _, _ in
        pendingCodexFastMode = nil
        composerSettingMutationInFlight = false
        composerSettingMutationGeneration &+= 1
      }
      .onChange(of: transcript) { _, _ in
        scheduleTimelineSnapshotRebuild()
      }
      .onChange(of: fallbackEntries) { _, _ in
        scheduleTimelineSnapshotRebuild()
      }
      .onChange(of: artifacts) { _, _ in
        scheduleTimelineSnapshotRebuild()
      }
      .onChange(of: localEchoMessages) { _, _ in
        scheduleTimelineSnapshotRebuild()
      }
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
        let currentModelId = chatSummary?.modelId ?? chatSummary?.model ?? ""
        WorkModelPickerSheet(
          currentModelId: currentModelId,
          currentProvider: chatSummary?.provider ?? "",
          currentReasoningEffort: chatSummary?.reasoningEffort ?? "",
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
              let currentReasoning = chatSummary?.reasoningEffort ?? ""
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

private struct WorkChatViewportHeightPreferenceKey: PreferenceKey {
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
        workChatCanvasBackground.opacity(0),
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
  let entries: [WorkTimelineEntry]
  let visibleEntries: [WorkTimelineEntry]
  let hiddenCount: Int

  static let empty = WorkTimelinePresentation(
    entries: [],
    visibleEntries: [],
    hiddenCount: 0
  )
}

private func makeWorkTimelinePresentation(
  timeline: [WorkTimelineEntry],
  visibleCount: Int,
  chatSummary: AgentChatSessionSummary?,
  transcript: [WorkChatEnvelope]
) -> WorkTimelinePresentation {
  let entries = injectWorkTurnSeparators(
    into: timeline,
    chatSummary: chatSummary,
    transcript: transcript
  )
  let visibleEntries = visibleWorkTimelineEntries(from: entries, visibleCount: visibleCount)
  return WorkTimelinePresentation(
    entries: entries,
    visibleEntries: visibleEntries,
    hiddenCount: max(entries.count - visibleEntries.count, 0)
  )
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
  let chatSummary: AgentChatSessionSummary?
  let usageViewModel: WorkContextUsageViewModel?
  let pendingInputCount: Int
  let awaitingInputGate: Bool
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
  let onSend: @MainActor (String) async -> Bool
  let onSent: () -> Void

  var body: some View {
    WorkChatComposerDraftInput(
      chatSummary: chatSummary,
      usageViewModel: usageViewModel,
      pendingInputCount: pendingInputCount,
      awaitingInputGate: awaitingInputGate,
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
      .glassEffect(in: .rect(cornerRadius: 24))
      .overlay(
        RoundedRectangle(cornerRadius: 24, style: .continuous)
          .fill(
            LinearGradient(
              colors: [Color.white.opacity(0.10), .clear],
              startPoint: .top,
              endPoint: .bottom
            )
          )
          .allowsHitTesting(false)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 24, style: .continuous)
          .stroke(ADEColor.glassBorder, lineWidth: 1)
      )
      .shadow(color: Color.black.opacity(0.42), radius: 18, y: 8)
  }
}

private struct WorkChatComposerDraftInput: View {
  let chatSummary: AgentChatSessionSummary?
  let usageViewModel: WorkContextUsageViewModel?
  let pendingInputCount: Int
  let awaitingInputGate: Bool
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
  let onSend: @MainActor (String) async -> Bool
  let onSent: () -> Void

  @StateObject private var draftState = WorkChatComposerDraftState()
  @State private var contextUsagePresented = false

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      WorkChatComposerTextField(
        draftState: draftState,
        canCompose: canCompose,
        placeholder: workChatComposerPlaceholder(
          pendingInputCount: pendingInputCount,
          sessionStatus: awaitingInputGate ? "awaiting-input" : ""
        )
      )

      if showInterrupt && draftState.hasSendableText {
        Text("Message will stage behind the active turn.")
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
          .frame(maxWidth: .infinity, alignment: .leading)
          .accessibilityIdentifier("Work.Chat.Composer.StagingHint")
      }

      HStack(alignment: .center, spacing: 6) {
        WorkComposerChipStrip(
          chatSummary: chatSummary,
          pendingInputCount: pendingInputCount,
          settingsMutationInFlight: settingsMutationInFlight,
          codexFastModeOverride: codexFastModeOverride,
          onOpenModelPicker: onOpenModelPicker,
          onSelectRuntimeMode: onSelectRuntimeMode,
          onToggleCodexFastMode: onToggleCodexFastMode
        )

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
              modelLabel: chatSummary?.model
            )
            .frame(maxWidth: 320, alignment: .leading)
            .presentationCompactAdaptation(.popover)
          }
        }

        if showInterrupt {
          if draftState.hasSendableText {
            stopButton()
            WorkChatComposerSendButton(
              draftState: draftState,
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
            canSend: canSend,
            sending: sending,
            onSend: onSend,
            onSent: onSent
          )
        }
      }
    }
    .onChange(of: usageViewModel) { _, newValue in
      if newValue == nil {
        contextUsagePresented = false
      }
    }
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
    .shadow(color: Color.black.opacity(0.32), radius: 14, y: 8)
    .accessibilityIdentifier("Work.Chat.Composer.ContextUsagePopover")
  }
}

private final class WorkChatComposerDraftState: ObservableObject {
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
  let canCompose: Bool
  let placeholder: String
  @FocusState private var composerFocused: Bool

  var body: some View {
    TextField(placeholder, text: $draftState.text, axis: .vertical)
      .textFieldStyle(.plain)
      .lineLimit(1...6)
      .font(.body)
      .foregroundStyle(ADEColor.textPrimary)
      .tint(ADEColor.accent)
      .disabled(!canCompose)
      .autocorrectionDisabled(false)
      .textInputAutocapitalization(.sentences)
      .focused($composerFocused)
      .frame(maxWidth: .infinity, minHeight: 24, alignment: .leading)
  }
}

private struct WorkChatComposerSendButton: View {
  @ObservedObject var draftState: WorkChatComposerDraftState
  let canSend: Bool
  let sending: Bool
  var accessibilityLabelText = "Send message"
  let onSend: @MainActor (String) async -> Bool
  let onSent: () -> Void

  private var sendEnabled: Bool {
    canSend && draftState.hasSendableText
  }

  var body: some View {
    Button {
      let text = draftState.consumeSendableText()
      Task { @MainActor in
        let sent = await onSend(text)
        if sent {
          onSent()
        } else {
          draftState.restoreUnsentText(text)
        }
      }
    } label: {
      ZStack {
        if sending {
          ProgressView()
            .controlSize(.mini)
            .tint(sendEnabled ? Color(red: 0.12, green: 0.12, blue: 0.14) : ADEColor.textSecondary)
        } else {
          Image(systemName: "arrow.up")
            .font(.system(size: 14, weight: .bold))
        }
      }
      .frame(width: 28, height: 28)
      .foregroundStyle(sendEnabled ? Color(red: 0.12, green: 0.12, blue: 0.14) : ADEColor.textSecondary.opacity(0.2))
      .background(
        Circle()
          .fill(sendEnabled ? Color.white.opacity(0.9) : Color.white.opacity(0.06))
      )
    }
    .buttonStyle(.plain)
    .accessibilityLabel(sending ? "Sending message" : accessibilityLabelText)
    .disabled(!sendEnabled)
    .adeInspectable(
      "Work.Chat.Composer.SendButton",
      metadata: [
        "label": sending ? "Sending message" : accessibilityLabelText,
        "role": "button"
      ]
    )
  }
}
