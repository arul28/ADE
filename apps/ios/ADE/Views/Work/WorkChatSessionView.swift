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
  let artifactRefreshInFlight: Bool
  let artifactRefreshError: String?
  @Binding var sending: Bool
  @Binding var errorMessage: String?
  @State var visibleTimelineCount = workTimelinePageSize
  @State var actionInFlight = false
  @State var isNearBottom = true
  @State var unreadBelowCount = 0
  @State var artifactDrawerPresented = false
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

  @State var steerEditDrafts: [String: String] = [:]
  @State var modelPickerPresented = false
  @State var modelUpdateInFlight = false

  var sessionStatus: String {
    normalizedWorkChatSessionStatus(session: session, summary: chatSummary)
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
    if sendWillQueue {
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
      if hiddenTimelineCount > 0 {
        Button {
          loadEarlierTimelineEntries()
        } label: {
          Label(
            "Load \(min(hiddenTimelineCount, workTimelinePageSize)) earlier message\(min(hiddenTimelineCount, workTimelinePageSize) == 1 ? "" : "s")",
            systemImage: "chevron.up.circle"
          )
          .font(.footnote.weight(.semibold))
          .frame(maxWidth: .infinity)
        }
        .buttonStyle(.glass)
        .tint(ADEColor.accent)
        .controlSize(.small)
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
      isStreaming: workChatIsStreaming(
        sessionStatus: sessionStatus,
        isLive: isLive,
        transcriptIndicatesActiveTurn: timelineSnapshot.transcriptIndicatesActiveTurn
      )
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
        queuedSteerCount: pendingSteers.count,
        pendingInputCount: pendingInputs.count,
        awaitingInputGate: hasPendingInputGate,
        canCompose: canCompose,
        canSend: canSend,
        sending: sending && !sendWillQueue,
        // Show a Stop affordance on the Send button while the assistant is
        // generating. The chip strip stays usable so users can switch
        // access/model mid-turn; interruption replaces "Send" with a
        // warning-tinted button.
        showInterrupt: isLive && sessionStatus == "active",
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
        artifactCount: artifacts.count,
        latestArtifact: artifacts.last,
        artifactRefreshInFlight: artifactRefreshInFlight,
        artifactRefreshError: artifactRefreshError,
        onOpenProof: { artifactDrawerPresented = true },
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
        .environment(\.workChatProvider, chatSummary?.provider)
        .environment(\.workChatModelId, chatSummary?.modelId ?? chatSummary?.model)
        .environment(\.workChatModelLabel, chatSummary.map { prettyWorkChatModelName($0.model) })
      }
      .scrollIndicators(.hidden)
      .scrollDismissesKeyboard(.interactively)
      .adeScreenBackground()
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
        let delta = newCount - oldCount
        guard delta > 0 else { return }
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

private struct WorkChatNavigationBackdrop: View {
  var body: some View {
    LinearGradient(
      colors: [
        ADEColor.pageBackground,
        ADEColor.pageBackground.opacity(0.96),
        ADEColor.pageBackground.opacity(0)
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
        ADEColor.pageBackground.opacity(0),
        ADEColor.pageBackground.opacity(0.94),
        ADEColor.pageBackground
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
  let queuedSteerCount: Int
  let pendingInputCount: Int
  let awaitingInputGate: Bool
  let canCompose: Bool
  let canSend: Bool
  let sending: Bool
  /// True while the assistant is streaming a response. Swaps the Send button
  /// for a warning-tinted Stop button that calls `onInterrupt` — replaces the
  /// old full-width yellow slab that used to sit under the header.
  let showInterrupt: Bool
  let interruptInFlight: Bool
  let onInterrupt: @MainActor () async -> Void
  let onOpenModelPicker: (() -> Void)?
  let onSelectRuntimeMode: ((String) -> Void)?
  let onSelectEffort: ((String) -> Void)?
  let artifactCount: Int
  let latestArtifact: ComputerUseArtifactSummary?
  let artifactRefreshInFlight: Bool
  let artifactRefreshError: String?
  let onOpenProof: () -> Void
  let onSend: @MainActor (String) async -> Bool
  let onSent: () -> Void

  var body: some View {
    WorkChatComposerDraftInput(
      chatSummary: chatSummary,
      queuedSteerCount: queuedSteerCount,
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
      artifactCount: artifactCount,
      latestArtifact: latestArtifact,
      artifactRefreshInFlight: artifactRefreshInFlight,
      artifactRefreshError: artifactRefreshError,
      onOpenProof: onOpenProof,
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
  let queuedSteerCount: Int
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
  let artifactCount: Int
  let latestArtifact: ComputerUseArtifactSummary?
  let artifactRefreshInFlight: Bool
  let artifactRefreshError: String?
  let onOpenProof: () -> Void
  let onSend: @MainActor (String) async -> Bool
  let onSent: () -> Void

  @StateObject private var draftState = WorkChatComposerDraftState()

  /// Brand color for the active chat surface, used on the Send pill. Mirrors
  /// desktop's provider-level chat accents: Claude amber, Codex warm white,
  /// with model color only as a fallback for providers outside that map.
  private var sendAccent: Color {
    ADEColor.chatSurfaceAccent(
      modelId: chatSummary?.modelId ?? chatSummary?.model,
      provider: chatSummary?.provider
    )
  }

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
          queuedSteerCount: queuedSteerCount,
          pendingInputCount: pendingInputCount,
          onOpenModelPicker: onOpenModelPicker,
          onSelectRuntimeMode: onSelectRuntimeMode,
          onSelectEffort: onSelectEffort
        )

        Spacer(minLength: 0)

        WorkProofComposerButton(
          count: artifactCount,
          latestArtifact: latestArtifact,
          isRefreshing: artifactRefreshInFlight,
          refreshError: artifactRefreshError,
          onOpen: onOpenProof
        )

        if showInterrupt {
          if draftState.hasSendableText {
            stopButton(compact: true)
            WorkChatComposerSendButton(
              draftState: draftState,
              canSend: canSend,
              sending: sending,
              accent: sendAccent,
              label: "Stage",
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
            accent: sendAccent,
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
      HStack(spacing: 5) {
        if interruptInFlight {
          ProgressView()
            .controlSize(.mini)
            .tint(Color.white)
        } else {
          Image(systemName: "stop.fill")
            .font(.system(size: 12, weight: .bold))
        }
        if !compact {
          Text("Stop")
            .font(.caption.weight(.semibold))
        }
      }
      .foregroundStyle(Color.white)
      .padding(.horizontal, compact ? 10 : 12)
      .padding(.vertical, 8)
      .background(
        Capsule(style: .continuous)
          .fill(ADEColor.warning)
      )
      .shadow(color: ADEColor.warning.opacity(0.4), radius: 8, y: 2)
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
  let accent: Color
  var label = "Send"
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
      HStack(spacing: 5) {
        if sending {
          ProgressView()
            .controlSize(.mini)
            .tint(sendEnabled ? Color.white : ADEColor.textSecondary)
        } else {
          Image(systemName: "paperplane.fill")
            .font(.system(size: 12, weight: .bold))
        }
        Text(label)
          .font(.caption.weight(.semibold))
      }
      .foregroundStyle(sendEnabled ? Color.white : ADEColor.textSecondary)
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .background(
        Capsule(style: .continuous)
          .fill(sendEnabled ? accent : ADEColor.surfaceBackground.opacity(0.85))
      )
      .overlay(
        Capsule(style: .continuous)
          .stroke(sendEnabled ? Color.clear : ADEColor.border.opacity(0.35), lineWidth: 0.8)
      )
      .shadow(color: sendEnabled ? accent.opacity(0.4) : .clear, radius: 8, y: 2)
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

private struct WorkProofComposerButton: View {
  let count: Int
  let latestArtifact: ComputerUseArtifactSummary?
  let isRefreshing: Bool
  let refreshError: String?
  let onOpen: () -> Void

  private var tint: Color {
    refreshError == nil ? ADEColor.accent : ADEColor.danger
  }

  var body: some View {
    Button(action: onOpen) {
      ZStack(alignment: .topTrailing) {
        ZStack {
          if isRefreshing {
            ProgressView()
              .controlSize(.mini)
              .tint(tint)
          } else {
            Image(systemName: "cube.transparent")
              .font(.system(size: 14, weight: .semibold))
              .foregroundStyle(tint)
          }
        }
        .frame(width: 32, height: 32)
        .background(ADEColor.raisedBackground.opacity(0.88), in: Circle())
        .overlay(
          Circle()
            .stroke(tint.opacity(refreshError == nil ? 0.28 : 0.5), lineWidth: 0.8)
        )

        if refreshError != nil {
          Image(systemName: "exclamationmark")
            .font(.system(size: 8, weight: .black))
            .foregroundStyle(Color.white)
            .frame(width: 14, height: 14)
            .background(ADEColor.danger, in: Circle())
            .offset(x: 3, y: -3)
        } else if count > 0 {
          Text("\(min(count, 99))")
            .font(.system(size: 9, weight: .bold, design: .rounded))
            .foregroundStyle(Color.white)
            .frame(minWidth: 15, minHeight: 15)
            .background(tint, in: Capsule())
            .offset(x: 4, y: -4)
        }
      }
    }
    .buttonStyle(.plain)
    .accessibilityLabel(accessibilityLabel)
    .accessibilityHint("Opens the proof drawer")
    .adeInspectable(
      "Work.Chat.Composer.ProofButton",
      metadata: [
        "label": accessibilityLabel,
        "role": "button"
      ]
    )
  }

  private var accessibilityLabel: String {
    if let refreshError {
      return "Proof drawer, refresh failed: \(refreshError)"
    }
    guard let latestArtifact else {
      return "Proof drawer, no artifacts"
    }
    return "Proof drawer, \(count) artifact\(count == 1 ? "" : "s"), latest \(workArtifactKindLabel(latestArtifact.artifactKind)) \(relativeTimestamp(latestArtifact.createdAt))"
  }
}
