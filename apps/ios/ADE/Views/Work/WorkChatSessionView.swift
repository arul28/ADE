import SwiftUI
import UIKit
import AVKit

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
  @State var timelineSnapshot = WorkChatTimelineSnapshot.empty
  @State var timelinePresentation = WorkTimelinePresentation.empty
  @State var timelineRebuildTask: Task<Void, Never>?
  @State var timelineRebuildGeneration = 0
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
  let onSelectRuntimeMode: @MainActor (String) async -> Void
  let onSelectEffort: @MainActor (String) async -> Void

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

  /// Combined "a turn is active" signal: transcript-derived (status/done
  /// events in the local window) OR the live host hint. Either alone can
  /// miss — the transcript window may have dropped the `status: started`
  /// event, and the hint is absent on older hosts.
  var transcriptOrHintIndicatesActiveTurn: Bool {
    timelineSnapshot.transcriptIndicatesActiveTurn || liveTurnActiveHint
  }

  /// Single source of truth for "the assistant is generating right now".
  /// Drives the activity indicator, the composer stop button, and the
  /// streaming-markdown fast path.
  var isStreamingTurn: Bool {
    workChatIsStreaming(
      sessionStatus: sessionStatus,
      isLive: isLive,
      transcriptIndicatesActiveTurn: transcriptOrHintIndicatesActiveTurn
    )
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
    let nextPresentation = makeWorkTimelinePresentation(
      timeline: sourceTimeline ?? timelineSnapshot.timeline,
      visibleCount: visibleTimelineCount,
      chatSummary: chatSummary,
      transcript: transcript
    )
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
    if sending && !sendWillQueue {
      return "Sending message to machine..."
    }
    if sendWillQueue, pendingSteers.isEmpty {
      return sessionStatus == "active"
        ? "Message will stage behind the active turn."
        : "Machine is reconnecting. Send will queue until it is back."
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
        pendingInputCount: pendingInputs.count,
        awaitingInputGate: hasPendingInputGate,
        canCompose: canCompose,
        canSend: canSend,
        sending: sending && !sendWillQueue,
        // Show a Stop affordance on the Send button while the assistant is
        // generating. The chip strip stays usable so users can switch
        // access/model mid-turn; interruption replaces "Send" with a
        // warning-tinted button. Gated on the combined streaming signal, not
        // just the session row status — the row arrives via the (slower)
        // changeset pump and a desktop-started turn would otherwise stream
        // output with no way to stop it from the phone.
        showInterrupt: isStreamingTurn,
        interruptInFlight: actionInFlight,
        onInterrupt: {
          await runSessionAction(onInterrupt)
        },
        onOpenModelPicker: chatSummary == nil ? nil : { modelPickerPresented = true },
        onSelectRuntimeMode: chatSummary == nil ? nil : { mode in
          Task { await onSelectRuntimeMode(mode) }
        },
        onSelectEffort: chatSummary == nil ? nil : { effort in
          Task { await onSelectEffort(effort) }
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
            .onAppear {
              isNearBottom = true
            }
            .onDisappear {
              isNearBottom = false
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
      .background(workChatCanvasBackground.ignoresSafeArea())
      .adeNavigationGlass()
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
        if unreadBelowCount > 0 {
          WorkJumpToLatestPill(count: unreadBelowCount) {
            scrollToLatest(proxy, animated: true)
            unreadBelowCount = 0
          }
          .padding(.trailing, 16)
          .padding(.bottom, jumpToLatestPillBottomPadding)
          .transition(.move(edge: .trailing).combined(with: .opacity))
        }
      }
      .onChange(of: timeline.count) { oldCount, newCount in
        let previousTailId = lastTimelineTailId
        lastTimelineTailId = timeline.last?.id
        let delta = newCount - oldCount
        guard delta > 0 else { return }
        // Older-page prepends grow the timeline above the viewport — the
        // newest entry stays put. Don't autoscroll to the bottom or flag
        // the prepended entries as "new messages below".
        if let previousTailId, previousTailId == timeline.last?.id { return }
        if isNearBottom {
          scrollToLatest(proxy, animated: false)
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
      .onChange(of: isNearBottom) { _, nearBottom in
        guard nearBottom, unreadBelowCount > 0 else { return }
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
  let pendingInputCount: Int
  let awaitingInputGate: Bool
  let canCompose: Bool
  let canSend: Bool
  let sending: Bool
  /// True while the assistant is streaming a response. Swaps the Send button
  /// Desktop parity: red bordered stop control in the composer while a turn is
  /// active (`border-red-500/25 bg-red-500/[0.08] text-red-400/80`).
  /// old full-width yellow slab that used to sit under the header.
  let showInterrupt: Bool
  let interruptInFlight: Bool
  let onInterrupt: @MainActor () async -> Void
  let onOpenModelPicker: (() -> Void)?
  let onSelectRuntimeMode: ((String) -> Void)?
  let onSelectEffort: ((String) -> Void)?
  let onSend: @MainActor (String) async -> Bool
  let onSent: () -> Void

  var body: some View {
    WorkChatComposerDraftInput(
      chatSummary: chatSummary,
      pendingInputCount: pendingInputCount,
      awaitingInputGate: awaitingInputGate,
      canCompose: canCompose,
      canSend: canSend,
      sending: sending,
      showInterrupt: showInterrupt,
      interruptInFlight: interruptInFlight,
      onInterrupt: onInterrupt,
      onOpenModelPicker: onOpenModelPicker,
      onSelectRuntimeMode: onSelectRuntimeMode,
      onSelectEffort: onSelectEffort,
      onSend: onSend,
      onSent: onSent
    )
    .padding(.horizontal, 14)
    .padding(.vertical, 14)
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
  let pendingInputCount: Int
  let awaitingInputGate: Bool
  let canCompose: Bool
  let canSend: Bool
  let sending: Bool
  let showInterrupt: Bool
  let interruptInFlight: Bool
  let onInterrupt: @MainActor () async -> Void
  let onOpenModelPicker: (() -> Void)?
  let onSelectRuntimeMode: ((String) -> Void)?
  let onSelectEffort: ((String) -> Void)?
  let onSend: @MainActor (String) async -> Bool
  let onSent: () -> Void

  @StateObject private var draftState = WorkChatComposerDraftState()

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      WorkChatComposerTextField(
        draftState: draftState,
        canCompose: canCompose,
        placeholder: workChatComposerPlaceholder(
          pendingInputCount: pendingInputCount,
          sessionStatus: awaitingInputGate ? "awaiting-input" : ""
        )
      )

      HStack(alignment: .center, spacing: 8) {
        WorkComposerChipStrip(
          chatSummary: chatSummary,
          pendingInputCount: pendingInputCount,
          onOpenModelPicker: onOpenModelPicker,
          onSelectRuntimeMode: onSelectRuntimeMode,
          onSelectEffort: onSelectEffort
        )

        Spacer(minLength: 0)

        if showInterrupt {
          if draftState.hasSendableText {
            stopButton(compact: true)
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
  }

  @ViewBuilder
  private func stopButton(compact: Bool = false) -> some View {
    Button {
      Task { await onInterrupt() }
    } label: {
      Group {
        if compact {
          stopButtonIcon(compact: true)
        } else {
          HStack(spacing: 5) {
            stopButtonIcon(compact: false)
            Text("Stop")
              .font(.caption.weight(.semibold))
          }
          .padding(.horizontal, 12)
          .padding(.vertical, 8)
        }
      }
      .foregroundStyle(ADEColor.danger.opacity(0.85))
      .frame(width: compact ? 28 : nil, height: compact ? 28 : nil)
      .background(
        RoundedRectangle(cornerRadius: compact ? 8 : 10, style: .continuous)
          .fill(ADEColor.danger.opacity(0.08))
      )
      .overlay(
        RoundedRectangle(cornerRadius: compact ? 8 : 10, style: .continuous)
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
  private func stopButtonIcon(compact: Bool) -> some View {
    if interruptInFlight {
      ProgressView()
        .controlSize(.mini)
        .tint(ADEColor.danger)
    } else {
      Image(systemName: "stop.fill")
        .font(.system(size: compact ? 10 : 12, weight: .bold))
    }
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
      .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
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
