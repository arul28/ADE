import SwiftUI
import UIKit
import AVKit

struct WorkChatSessionView: View {
  @Environment(\.accessibilityReduceMotion) var reduceMotion

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
  @State var inputResponseText = ""
  @State var actionInFlight = false
  @State var isNearBottom = true
  @State var unreadBelowCount = 0
  @State var artifactDrawerPresented = false
  @State var timelineSnapshot = WorkChatTimelineSnapshot.empty
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
  let onSelectModel: @MainActor (String) async -> Void
  let onSelectRuntimeMode: @MainActor (String) async -> Void
  let onSelectEffort: @MainActor (String) async -> Void

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
  /// user-message turn. Computed view-side so the async snapshot stays focused
  /// on raw transcript shaping; separators prefer the model recorded on that
  /// turn's terminal event so older turns do not relabel when the session model
  /// changes.
  var timelineWithSeparators: [WorkTimelineEntry] {
    injectWorkTurnSeparators(into: timeline, chatSummary: chatSummary, transcript: transcript)
  }

  var visibleTimeline: [WorkTimelineEntry] {
    visibleWorkTimelineEntries(from: timelineWithSeparators, visibleCount: visibleTimelineCount)
  }

  var hiddenTimelineCount: Int {
    max(timelineWithSeparators.count - visibleTimeline.count, 0)
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

  var sessionOverviewSection: AnyView {
    AnyView(
      Group {
        // Pending-input cards now render inline at their chronological position
        // in the timeline via `timelineEntryView`. The overview section only
        // surfaces offline banners and chat-level errors.
        if !isLive {
          ForEach(pendingInputs) { item in
            switch item {
            case .approval:
              ADENoticeCard(
                title: "Approval waiting on host",
                message: "Reconnect to approve or deny this tool request. Cached transcript data may be slightly behind the desktop.",
                icon: "lock.shield",
                tint: ADEColor.warning,
                actionTitle: nil,
                action: nil
              )
            case .question:
              ADENoticeCard(
                title: "Host needs your answer",
                message: "Reconnect to respond to this question. The host keeps the session paused until input arrives.",
                icon: "questionmark.circle",
                tint: ADEColor.warning,
                actionTitle: nil,
                action: nil
              )
            case .permission:
              ADENoticeCard(
                title: "Permission request waiting",
                message: "Reconnect to allow or decline this tool's permission gate.",
                icon: "lock.shield",
                tint: ADEColor.warning,
                actionTitle: nil,
                action: nil
              )
            }
          }
        }

        // When live, approval_request cards (tool approval gates) still render
        // at the top — they are not suppressed from the pendingInputs set, only
        // structured questions and permission gates get their inline treatment.
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

        if let errorMessage {
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
    )
  }

  var timelineSection: AnyView {
    AnyView(
      Group {
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
    )
  }

  var streamingStatusSection: AnyView {
    AnyView(
      WorkActivityIndicator(
        transcript: transcript,
        isStreaming: sessionStatus == "active" && isLive
      )
    )
  }

  /// Single desktop-shaped composer card: text field on top, chip strip and
  /// send button on the bottom, everything wrapped in one rounded container
  /// with clear contrast against the chat background.
  func composerInset(proxy: ScrollViewProxy) -> AnyView {
    AnyView(
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
          onSend: onSend,
          onSent: {
            withAnimation(ADEMotion.quick(reduceMotion: reduceMotion)) {
              proxy.scrollTo("chat-end", anchor: .bottom)
            }
          }
        )
      }
      .padding(.horizontal, 16)
      .padding(.top, 8)
      .padding(.bottom, 0)
    )
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
            withAnimation(ADEMotion.quick(reduceMotion: reduceMotion)) {
              proxy.scrollTo("chat-end", anchor: .bottom)
            }
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
          withAnimation(ADEMotion.quick(reduceMotion: reduceMotion)) {
            proxy.scrollTo("chat-end", anchor: .bottom)
          }
        } else {
          withAnimation(ADEMotion.standard(reduceMotion: reduceMotion)) {
            unreadBelowCount += delta
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
        scheduleTimelineSnapshotRebuild()
      }
      .onDisappear {
        cancelScheduledTimelineSnapshotRebuild()
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
    }
  }
}

private struct WorkChatComposerCard: View {
  @Environment(\.accessibilityReduceMotion) var reduceMotion

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
  let onSend: @MainActor (String) async -> Bool
  let onSent: () -> Void

  @State private var draft = ""

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
        .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)

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
          stopButton
        } else {
          sendButton
        }
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 14)
    .background(composerSurface)
  }

  @ViewBuilder
  private var sendButton: some View {
    Button {
      let text = trimmedDraft
      draft = ""
      Task {
        let sent = await onSend(text)
        if sent {
          onSent()
        } else {
          draft = text
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
        Text("Send")
          .font(.caption.weight(.semibold))
      }
      .foregroundStyle(sendEnabled ? Color.white : ADEColor.textSecondary)
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .background(
        Capsule(style: .continuous)
          .fill(sendEnabled ? sendAccent : ADEColor.surfaceBackground.opacity(0.85))
      )
      .overlay(
        Capsule(style: .continuous)
          .stroke(sendEnabled ? Color.clear : ADEColor.border.opacity(0.35), lineWidth: 0.8)
      )
      .shadow(color: sendEnabled ? sendAccent.opacity(0.4) : .clear, radius: 8, y: 2)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(sending ? "Sending message" : "Send message")
    .disabled(!sendEnabled)
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

  private var composerSurface: some View {
    RoundedRectangle(cornerRadius: 24, style: .continuous)
      .fill(ADEColor.composerBackground)
      .overlay(
        RoundedRectangle(cornerRadius: 24, style: .continuous)
          .stroke(ADEColor.glassBorder, lineWidth: 1)
      )
      .shadow(color: Color.black.opacity(0.42), radius: 18, y: 8)
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
