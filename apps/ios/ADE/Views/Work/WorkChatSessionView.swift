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
  @Binding var composer: String
  @Binding var sending: Bool
  @Binding var errorMessage: String?
  @State var visibleTimelineCount = workTimelinePageSize
  @State var inputResponseText = ""
  @State var actionInFlight = false
  @State var isNearBottom = true
  @State var unreadBelowCount = 0
  let isLive: Bool
  let disconnectedNotice: Bool
  let transitionNamespace: Namespace.ID?
  let onOpenLane: (() -> Void)?
  let onOpenSettings: (() -> Void)?
  let onSend: @MainActor () async -> Void
  let onInterrupt: @MainActor () async -> Void
  let onDispose: @MainActor () async -> Void
  let onResume: @MainActor () async -> Void
  let onApproveRequest: @MainActor (String, AgentChatApprovalDecision) async -> Void
  let onRespondToQuestion: @MainActor (String, String?, String?) async -> Void
  let onRetryLoad: @MainActor () async -> Void
  let onOpenFile: @MainActor (String) async -> Void
  let onOpenPr: @MainActor (Int) async -> Void
  let onLoadArtifact: @MainActor (ComputerUseArtifactSummary) async -> Void
  let onCancelSteer: @MainActor (String) async -> Void
  let onEditSteer: @MainActor (String, String) async -> Void
  let onSelectModel: @MainActor (String) async -> Void

  @State var steerEditDrafts: [String: String] = [:]
  @State var modelPickerPresented = false
  @State var modelUpdateInFlight = false

  var sessionStatus: String {
    normalizedWorkChatSessionStatus(session: session, summary: chatSummary)
  }

  var pendingInputs: [WorkPendingInputItem] {
    derivePendingWorkInputs(from: transcript)
  }

  var pendingSteers: [WorkPendingSteerModel] {
    derivePendingWorkSteers(from: transcript)
  }

  var primaryPendingInput: WorkPendingInputItem? {
    pendingInputs.first
  }

  var toolCards: [WorkToolCardModel] {
    buildWorkToolCards(from: transcript)
  }

  var eventCards: [WorkEventCardModel] {
    buildWorkEventCards(from: transcript)
  }

  var commandCards: [WorkCommandCardModel] {
    buildWorkCommandCards(from: transcript)
  }

  var fileChangeCards: [WorkFileChangeCardModel] {
    buildWorkFileChangeCards(from: transcript)
  }

  var sessionUsageSummary: WorkUsageSummary? {
    summarizeWorkSessionUsage(from: transcript)
  }

  var timeline: [WorkTimelineEntry] {
    buildWorkTimeline(
      transcript: transcript,
      fallbackEntries: fallbackEntries,
      toolCards: toolCards,
      commandCards: commandCards,
      fileChangeCards: fileChangeCards,
      eventCards: eventCards,
      artifacts: artifacts,
      localEchoMessages: localEchoMessages
    )
  }

  var visibleTimeline: [WorkTimelineEntry] {
    visibleWorkTimelineEntries(from: timeline, visibleCount: visibleTimelineCount)
  }

  var hiddenTimelineCount: Int {
    max(timeline.count - visibleTimeline.count, 0)
  }

  var canCompose: Bool {
    isLive && !sending && sessionStatus != "ended"
  }

  var composerFeedback: String? {
    if !isLive {
      return "Reconnect to send or resume this chat."
    }
    if sessionStatus == "ended" {
      return "Resume this chat before sending another message."
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
        WorkSessionHeader(
          session: session,
          chatSummary: chatSummary,
          transitionNamespace: transitionNamespace,
          onOpenLane: onOpenLane,
          onOpenSettings: onOpenSettings
        )

        if let sessionUsageSummary {
          WorkSessionUsageSummaryCard(summary: sessionUsageSummary)
        }

        if isLive {
          WorkSessionControlBar(
            status: sessionStatus,
            actionInFlight: actionInFlight,
            onInterrupt: {
              await runSessionAction(onInterrupt)
            },
            onResume: {
              await runSessionAction(onResume)
            },
            onDispose: {
              await runSessionAction(onDispose)
            }
          )
        }

        ForEach(pendingInputs) { item in
          if isLive {
            switch item {
            case .approval(let approval):
              WorkApprovalRequestCard(
                approval: approval,
                busy: actionInFlight,
                onDecision: { decision in
                  await runSessionAction {
                    await onApproveRequest(approval.id, decision)
                  }
                }
              )
            case .question(let question):
              WorkStructuredQuestionCard(
                question: question,
                responseText: $inputResponseText,
                busy: actionInFlight,
                onSelectOption: { option in
                  await runSessionAction {
                    await onRespondToQuestion(question.id, option, inputResponseText)
                    inputResponseText = ""
                  }
                },
                onSubmitFreeform: {
                  await runSessionAction {
                    await onRespondToQuestion(question.id, nil, inputResponseText)
                    inputResponseText = ""
                  }
                }
              )
            }
          } else {
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
            }
          }
        }

        if disconnectedNotice {
          ADENoticeCard(
            title: "Connection lost",
            message: "Cached messages stay visible, but sending, streaming, and artifact refresh are paused until the host reconnects.",
            icon: "wifi.slash",
            tint: ADEColor.warning,
            actionTitle: nil,
            action: nil
          )
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

  func composerInset(proxy: ScrollViewProxy) -> AnyView {
    AnyView(
      VStack(spacing: 10) {
        HStack(spacing: 8) {
          ADEStatusPill(
            text: isLive ? sessionStatusLabel(for: sessionStatus) : "OFFLINE",
            tint: isLive ? workChatStatusTint(sessionStatus) : ADEColor.warning
          )

          if sessionStatus == "active" && isLive {
            ProgressView()
              .controlSize(.small)
              .tint(ADEColor.accent)
          }

          Spacer(minLength: 0)

          if sessionStatus == "active" && isLive {
            Button {
              Task { await runSessionAction(onInterrupt) }
            } label: {
              Label("Stop", systemImage: "stop.fill")
                .labelStyle(.iconOnly)
                .frame(width: 32, height: 32)
            }
            .buttonStyle(.glass)
            .tint(ADEColor.warning)
            .disabled(actionInFlight || sending)
            .accessibilityLabel("Interrupt chat")
          } else if (sessionStatus == "idle" || sessionStatus == "ended") && isLive {
            Button {
              Task { await runSessionAction(onResume) }
            } label: {
              Label("Resume", systemImage: "play.fill")
                .labelStyle(.iconOnly)
                .frame(width: 32, height: 32)
            }
            .buttonStyle(.glass)
            .tint(ADEColor.accent)
            .disabled(actionInFlight || sending)
            .accessibilityLabel("Resume chat")
          }
        }

        WorkComposerChipStrip(
          chatSummary: chatSummary,
          queuedSteerCount: pendingSteers.count,
          pendingInputCount: pendingInputs.count,
          onOpenModelPicker: chatSummary == nil ? nil : { modelPickerPresented = true },
          onOpenSettings: onOpenSettings
        )

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

        HStack(alignment: .bottom, spacing: 10) {
          TextField("Send a message", text: $composer, axis: .vertical)
            .textFieldStyle(.plain)
            .lineLimit(1...6)
            .adeInsetField(cornerRadius: 14, padding: 12)
            .disabled(!canCompose)

          Button {
            Task {
              await onSend()
              withAnimation(ADEMotion.quick(reduceMotion: transitionNamespace == nil)) {
                proxy.scrollTo("chat-end", anchor: .bottom)
              }
            }
          } label: {
            Image(systemName: sending ? "ellipsis.circle" : "paperplane.fill")
              .font(.system(size: 18, weight: .semibold))
              .foregroundStyle(ADEColor.accent)
              .frame(width: 44, height: 44)
              .background(ADEColor.accent.opacity(0.12), in: Circle())
          }
          .accessibilityLabel(sending ? "Sending message" : "Send message")
          .disabled(!canCompose || composer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }

        if let composerFeedback {
          Text(composerFeedback)
            .font(.caption2)
            .foregroundStyle(sessionStatus == "awaiting-input" ? ADEColor.warning : ADEColor.textMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
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
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 10)
      .background(ADEColor.surfaceBackground.opacity(0.08))
      .glassEffect()
    )
  }

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 14) {
          sessionOverviewSection
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
      }
      .scrollIndicators(.hidden)
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
      .sheet(isPresented: $modelPickerPresented) {
        WorkModelPickerSheet(
          currentModelId: chatSummary?.model ?? "",
          currentProvider: chatSummary?.provider ?? "",
          isBusy: modelUpdateInFlight,
          onSelect: { option in
            Task {
              modelUpdateInFlight = true
              await onSelectModel(option.id)
              modelUpdateInFlight = false
              modelPickerPresented = false
            }
          },
          onOpenSettings: onOpenSettings
        )
      }
    }
  }
}
