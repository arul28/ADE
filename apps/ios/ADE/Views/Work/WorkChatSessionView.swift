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

  /// Optional lane list forwarded from the parent so the `@`-mention picker can offer lane names.
  /// When nil the `@` button is still shown but the sheet will display an empty list.
  var lanes: [LaneSummary] = []

  @State var steerEditDrafts: [String: String] = [:]
  @State var modelPickerPresented = false
  @State var modelUpdateInFlight = false
  @State var mentionsSheetPresented = false
  @State var slashSheetPresented = false
  @State var pendingComposerInsert: String?

  var sessionStatus: String {
    normalizedWorkChatSessionStatus(session: session, summary: chatSummary)
  }

  var pendingInputs: [WorkPendingInputItem] {
    timelineSnapshot.pendingInputs
  }

  var pendingSteers: [WorkPendingSteerModel] {
    timelineSnapshot.pendingSteers
  }

  var primaryPendingInput: WorkPendingInputItem? {
    pendingInputs.first
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
    // a turn is running. Only Send is gated via `canSend`; the feedback line
    // below the composer explains why send is disabled.
    isLive
  }

  var canSend: Bool {
    // Match desktop: a chat accepts messages as long as the app is live. A
    // completed turn (`sessionStatus == "ended"`) just means the previous
    // round finished — the user's next message starts a new turn. Only
    // client-side archive and disconnected state should gate Send.
    isLive && !sending
  }

  var composerFeedback: String? {
    if !isLive {
      return "Reconnect to send messages."
    }
    if sending {
      return "Sending message to host..."
    }
    if sessionStatus == "awaiting-input" {
      return "Answer the waiting prompt above, or send extra context."
    }
    return nil
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
  var timelineSection: some View {
    if timeline.isEmpty {
      ADEEmptyStateView(
        symbol: "bubble.left.and.bubble.right",
        title: "No chat messages yet",
        message: isLive ? "Send a message to start streaming the transcript." : "Reconnect to load the latest chat history from the host."
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
        timelineEntryView(for: entry)
      }
    }
  }

  var streamingStatusSection: some View {
    WorkActivityIndicator(
      transcript: transcript,
      isStreaming: sessionStatus == "active" && isLive
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

      if let primary = primaryPendingInput {
        let overflow = max(pendingInputs.count - 1, 0)
        switch primary {
        case .approval(let approval):
          WorkComposerInputBanner(
            title: overflow > 0 ? "Approval waiting (+\(overflow) more)" : "Approval waiting",
            message: approval.description,
            icon: "checkmark.shield",
            tint: ADEColor.warning
          )
        case .question(let question):
          WorkComposerInputBanner(
            title: overflow > 0 ? "Question waiting (+\(overflow) more)" : "Question waiting",
            message: question.question,
            icon: "questionmark.circle",
            tint: ADEColor.warning
          )
        case .permission(let permission):
          WorkComposerInputBanner(
            title: overflow > 0 ? "Permission waiting (+\(overflow) more)" : "Permission waiting",
            message: permission.description,
            icon: "lock.shield",
            tint: ADEColor.warning
          )
        case .planApproval(let plan):
          // Plan-approval cards render inline in the timeline. The composer
          // banner just gives a lightweight heads-up so the user knows there's
          // a decision waiting even if they haven't scrolled to it yet.
          WorkComposerInputBanner(
            title: overflow > 0 ? "Plan approval waiting (+\(overflow) more)" : "Plan approval waiting",
            message: plan.title,
            icon: "list.bullet.clipboard",
            tint: Color(red: 0.95, green: 0.72, blue: 0.15)
          )
        }
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
              }
            }
          },
          onDispatchInterrupt: onDispatchSteerInterrupt.map { dispatch in
            { steerId in
              await runSessionAction {
                await dispatch(steerId)
                steerEditDrafts.removeValue(forKey: steerId)
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
        canCompose: canCompose,
        canSend: canSend,
        sending: sending,
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
        pendingInsert: $pendingComposerInsert,
        onOpenMentions: { mentionsSheetPresented = true },
        onOpenSlash: { slashSheetPresented = true },
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
          timelineSection
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
      .safeAreaInset(edge: .bottom) {
        composerInset(proxy: proxy)
      }
      .overlay(alignment: .bottomTrailing) {
        if unreadBelowCount > 0 {
          WorkJumpToLatestPill(count: unreadBelowCount) {
            scrollToLatest(proxy, animated: true)
            unreadBelowCount = 0
          }
          .padding(.trailing, 16)
          .padding(.bottom, 14)
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
              let wasCurrentModel = option.id == currentModelId
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
      .sheet(isPresented: $mentionsSheetPresented) {
        WorkMentionsPickerSheet(lanes: lanes) { token in
          pendingComposerInsert = token
          mentionsSheetPresented = false
        }
      }
      .sheet(isPresented: $slashSheetPresented) {
        WorkSlashCommandsSheet(provider: chatSummary?.provider ?? session.toolType ?? "") { token in
          pendingComposerInsert = token
          slashSheetPresented = false
        }
      }
    }
  }
}

struct WorkTimelinePresentation: Equatable {
  let entries: [WorkTimelineEntry]
  let visibleEntries: [WorkTimelineEntry]
  let hiddenCount: Int
  let latestVisibleAssistantMessageId: String?

  static let empty = WorkTimelinePresentation(
    entries: [],
    visibleEntries: [],
    hiddenCount: 0,
    latestVisibleAssistantMessageId: nil
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
    hiddenCount: max(entries.count - visibleEntries.count, 0),
    latestVisibleAssistantMessageId: latestVisibleAssistantMessageId(in: visibleEntries)
  )
}

private func latestVisibleAssistantMessageId(in entries: [WorkTimelineEntry]) -> String? {
  for entry in entries.reversed() {
    if case .message(let message) = entry.payload, message.role.lowercased() == "assistant" {
      return message.id
    }
  }
  return nil
}

private struct WorkChatComposerCard: View {
  let chatSummary: AgentChatSessionSummary?
  let queuedSteerCount: Int
  let pendingInputCount: Int
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
  @Binding var pendingInsert: String?
  let onOpenMentions: () -> Void
  let onOpenSlash: () -> Void
  let onSend: @MainActor (String) async -> Bool
  let onSent: () -> Void

  var body: some View {
    WorkChatComposerDraftInput(
      chatSummary: chatSummary,
      queuedSteerCount: queuedSteerCount,
      pendingInputCount: pendingInputCount,
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
      pendingInsert: $pendingInsert,
      onOpenMentions: onOpenMentions,
      onOpenSlash: onOpenSlash,
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
  @Binding var pendingInsert: String?
  let onOpenMentions: () -> Void
  let onOpenSlash: () -> Void
  let onSend: @MainActor (String) async -> Bool
  let onSent: () -> Void

  @State private var draft = ""
  @FocusState private var composerFocused: Bool

  private var trimmedDraft: String {
    draft.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private var sendEnabled: Bool {
    canSend && !trimmedDraft.isEmpty
  }

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
      TextField("Type to vibecode…", text: $draft, axis: .vertical)
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
        .onChange(of: pendingInsert) { _, token in
          guard let token, !token.isEmpty else { return }
          if !draft.isEmpty && !draft.hasSuffix(" ") && !draft.hasSuffix("\n") {
            draft += " "
          }
          draft += token
          pendingInsert = nil
          composerFocused = true
        }

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

        // @ mentions button
        Button(action: onOpenMentions) {
          Image(systemName: "at")
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(ADEColor.textSecondary)
            .frame(width: 28, height: 28)
            .background(ADEColor.raisedBackground.opacity(0.7), in: Circle())
            .overlay(Circle().stroke(ADEColor.glassBorder, lineWidth: 0.6))
        }
        .buttonStyle(.plain)
        .disabled(!canCompose)
        .accessibilityLabel("Insert @ mention")

        // / slash-command button
        Button(action: onOpenSlash) {
          Text("/")
            .font(.system(size: 14, weight: .bold))
            .foregroundStyle(ADEColor.textSecondary)
            .frame(width: 28, height: 28)
            .background(ADEColor.raisedBackground.opacity(0.7), in: Circle())
            .overlay(Circle().stroke(ADEColor.glassBorder, lineWidth: 0.6))
        }
        .buttonStyle(.plain)
        .disabled(!canCompose)
        .accessibilityLabel("Insert slash command")

        WorkProofComposerButton(
          count: artifactCount,
          latestArtifact: latestArtifact,
          isRefreshing: artifactRefreshInFlight,
          refreshError: artifactRefreshError,
          onOpen: onOpenProof
        )

        if showInterrupt {
          stopButton
        } else {
          sendButton
        }
      }
    }
  }

  @ViewBuilder
  private var sendButton: some View {
    let isSendEnabled = sendEnabled
    let accent = sendAccent
    Button {
      let text = trimmedDraft
      draft = ""
      Task { @MainActor in
        let sent = await onSend(text)
        if sent {
          onSent()
        } else {
          restoreUnsentDraft(text)
        }
      }
    } label: {
      HStack(spacing: 5) {
        if sending {
          ProgressView()
            .controlSize(.mini)
            .tint(isSendEnabled ? Color.white : ADEColor.textSecondary)
        } else {
          Image(systemName: "paperplane.fill")
            .font(.system(size: 12, weight: .bold))
        }
        Text("Send")
          .font(.caption.weight(.semibold))
      }
      .foregroundStyle(isSendEnabled ? Color.white : ADEColor.textSecondary)
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .background(
        Capsule(style: .continuous)
          .fill(isSendEnabled ? accent : ADEColor.surfaceBackground.opacity(0.85))
      )
      .overlay(
        Capsule(style: .continuous)
          .stroke(isSendEnabled ? Color.clear : ADEColor.border.opacity(0.35), lineWidth: 0.8)
      )
      .shadow(color: isSendEnabled ? accent.opacity(0.4) : .clear, radius: 8, y: 2)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(sending ? "Sending message" : "Send message")
    .disabled(!isSendEnabled)
  }

  private func restoreUnsentDraft(_ text: String) {
    let currentDraft = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard currentDraft != text else { return }
    if currentDraft.isEmpty {
      draft = text
    } else {
      draft = "\(text)\n\(draft)"
    }
  }

  @ViewBuilder
  private var stopButton: some View {
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
        Text("Stop")
          .font(.caption.weight(.semibold))
      }
      .foregroundStyle(Color.white)
      .padding(.horizontal, 12)
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
