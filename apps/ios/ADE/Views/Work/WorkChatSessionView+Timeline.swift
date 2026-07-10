import SwiftUI
import UIKit
import AVKit

extension WorkChatSessionView {
  /// Id of the assistant message still receiving streaming deltas, or nil
  /// when no turn is active. Only the LAST message qualifies, and only while
  /// the session is actively streaming — that message's bubble parses its
  /// markdown through the tail-only streaming parser; every completed message
  /// keeps the whole-text block cache path.
  var streamingAssistantMessageId: String? {
    guard shouldShowInterruptControl else { return nil }
    return timelineSnapshot.latestMessageAssistantId
  }

  @ViewBuilder
  func timelineRenderEntryView(
    for entry: WorkTimelineRenderEntry,
    proxy: ScrollViewProxy,
    streamingAssistantMessageId: String?,
    maxUserBubbleWidth: CGFloat?
  ) -> some View {
    switch entry.payload {
    case .entry(let timelineEntry):
      timelineEntryView(
        for: timelineEntry,
        proxy: proxy,
        streamingAssistantMessageId: streamingAssistantMessageId,
        maxUserBubbleWidth: maxUserBubbleWidth
      )
    case .assistantMarkdownBlock(let model):
      WorkAssistantMarkdownBlockRow(
        model: model,
        onCopyMessage: { copyAssistantMarkdown(messageId: model.messageId) }
      )
      .equatable()
    case .assistantMonospaced(let model):
      WorkAssistantMonospacedRow(
        model: model,
        onCopyMessage: { copyAssistantMarkdown(messageId: model.messageId) }
      )
      .equatable()
    case .assistantControls(let model):
      WorkAssistantMessageControlsView(
        controls: model,
        onCopyMessage: { copyAssistantMarkdown(messageId: model.messageId) },
        onShowMore: {
          assistantLineBudgets[model.messageId] = model.nextLineBudget
          refreshTimelinePresentation()
          if isNearBottom {
            pinToLatestAfterLayout(proxy, reason: "assistant-show-more")
          }
        }
      )
      .equatable()
    }
  }

  func copyAssistantMarkdown(messageId: String) {
    guard let markdown = assistantMarkdown(messageId: messageId) else { return }
    UIPasteboard.general.string = markdown
  }

  private func assistantMarkdown(messageId: String) -> String? {
    for entry in visibleTimeline.reversed() {
      if case .message(let message) = entry.payload,
         message.id == messageId {
        return message.markdown
      }
    }
    for entry in timelineSnapshot.timeline.reversed() {
      if case .message(let message) = entry.payload,
         message.id == messageId {
        return message.markdown
      }
    }
    return nil
  }

  @ViewBuilder
  func timelineEntryView(
    for entry: WorkTimelineEntry,
    proxy: ScrollViewProxy,
    streamingAssistantMessageId: String?,
    maxUserBubbleWidth: CGFloat?
  ) -> some View {
    switch entry.payload {
    case .message(let message):
      WorkChatMessageBubble(
        message: message,
        isStreaming: message.id == streamingAssistantMessageId,
        maxUserBubbleWidth: maxUserBubbleWidth
      )
    case .toolCard(let toolCard):
      timelineToolCard(toolCard)
    case .eventCard(let card):
      timelineEventCard(card)
    case .usageSummary(let summary):
      WorkTurnUsageSummaryBanner(
        summary: summary,
        provider: chatSummaryContext.provider,
        modelLabel: chatSummaryContext.modelLabel
      )
    case .commandCard(let commandCard):
      WorkCommandCardView(card: commandCard)
    case .fileChangeCard(let fileChangeCard):
      WorkFileChangeCardView(card: fileChangeCard)
    case .toolGroup(let group):
      timelineToolGroup(group)
    case .changedFiles(let group):
      timelineChangedFiles(group)
    case .artifact(let artifact):
      timelineArtifact(artifact)
    case .turnSeparator(let separator):
      WorkTurnSeparatorView(separator: separator)
    case .turnEndMarker(let marker):
      WorkTurnEndMarkerView(marker: marker)
    case .pendingQuestion(let question):
      // When offline, still render the card in a disabled (busy) state so the
      // transcript keeps its full context; the top-right gear icon already
      // communicates that the host is unreachable, so an extra "Reconnect to
      // respond" banner here would be redundant noise.
      WorkStructuredQuestionCard(
        question: question,
        busy: actionInFlight || !isLive,
        onSelectOption: { option, freeform in
          await runSessionAction {
            await onRespondToQuestion(
              question.id,
              question.questionId,
              .string(option.value),
              freeform
            )
          }
        },
        onSubmitAll: { answers, freeform in
          await runSessionAction {
            await onSubmitQuestionAnswers(question.id, answers, freeform)
          }
        },
        onDecline: {
          await runSessionAction {
            await onDeclineQuestion(question.id)
          }
        },
        onFreeformFocusChange: { focused in
          guard focused else { return }
          // Wait for the keyboard to start animating in so the ScrollView's
          // safe-area inset is updated before we ask it to scroll the focused
          // card above the keyboard.
          Task { @MainActor in
            try? await Task.sleep(nanoseconds: 300_000_000)
            withAnimation(.easeInOut(duration: 0.25)) {
              proxy.scrollTo("pending-question-\(question.id)", anchor: .bottom)
            }
          }
        },
        fallbackProvider: chatSummaryContext.provider
      )
      .id("pending-question-\(question.id)")
    case .pendingPermission(let permission):
      WorkPermissionCard(
        permission: permission,
        busy: actionInFlight || !isLive,
        onDecision: { decision in
          await runSessionAction {
            await onRespondToPermission(permission.id, decision)
          }
        }
      )
    case .pendingPlanApproval:
      EmptyView()
    case .pendingModelSelection(let request):
      WorkModelSelectionPendingCard(
        request: request,
        busy: actionInFlight || !isLive,
        onConfirm: { selectionJSON in
          await runSessionAction {
            await onSubmitQuestionAnswers(
              request.id,
              ["selection": .string(selectionJSON)],
              nil
            )
          }
        },
        onCancel: {
          await runSessionAction {
            await onDeclineQuestion(request.id)
          }
        }
      )
    }
  }

  @ViewBuilder
  func timelineToolGroup(_ group: WorkToolGroupModel) -> some View {
    WorkToolCallsPanelView(
      group: group,
      isExpanded: expandedToolCardIds.contains(group.id),
      onToggle: { toggleToolCard(group.id) }
    )
  }

  @ViewBuilder
  func timelineChangedFiles(_ group: WorkChangedFilesGroupModel) -> some View {
    WorkChangedFilesPanelView(
      group: group,
      isExpanded: expandedToolCardIds.contains(group.id),
      onToggle: { toggleToolCard(group.id) },
      onUndo: nil
    )
  }

  @ViewBuilder
  func timelineToolCard(_ toolCard: WorkToolCardModel) -> some View {
    WorkToolCardView(
      toolCard: toolCard,
      references: extractWorkNavigationTargets(from: [toolCard.argsText, toolCard.resultText].compactMap { $0 }.joined(separator: "\n")),
      isExpanded: expandedToolCardIds.contains(toolCard.id),
      onToggle: { toggleToolCard(toolCard.id) },
      onOpenFile: { path in
        Task { await onOpenFile(path) }
      },
      onOpenPr: { prNumber in
        Task { await onOpenPr(prNumber) }
      }
    )
  }

  @ViewBuilder
  func timelineEventCard(_ card: WorkEventCardModel) -> some View {
    if card.kind == "reasoning" {
      WorkReasoningCard(
        card: card,
        isLive: isReasoningLive(card)
      )
    } else if card.kind == "plan" {
      WorkProposedPlanCard(card: card)
    } else if card.kind == "question" {
      WorkResolvedQuestionCard(card: card, fallbackProvider: chatSummaryContext.provider)
    } else if card.kind == "planApproval" {
      WorkResolvedPlanCard(card: card, fallbackProvider: chatSummaryContext.provider)
    } else if card.kind == "approval" {
      WorkResolvedApprovalChip(card: card, fallbackProvider: chatSummaryContext.provider)
    } else if card.kind == "codexRecovery" {
      WorkCodexRecoveryCardView(
        card: card,
        sessionId: card.recoverySessionId ?? session.id,
        enabled: isLive,
        onRecover: onRecoverCodexTurn
      )
    } else {
      WorkEventCardView(
        card: card,
        onOpenFile: { path in Task { await onOpenFile(path) } },
        onOpenPr: { number in Task { await onOpenPr(number) } }
      )
    }
  }

  /// Reasoning is "live" when the session is streaming AND this is the most
  /// recent reasoning entry in the transcript. Everything older collapses.
  func isReasoningLive(_ card: WorkEventCardModel) -> Bool {
    guard isStreamingTurn else { return false }
    let latestReasoningId = eventCards.last(where: { $0.kind == "reasoning" })?.id
    return card.id == latestReasoningId
  }

  @ViewBuilder
  func timelineArtifact(_ artifact: ComputerUseArtifactSummary) -> some View {
    WorkArtifactView(
      artifact: artifact,
      content: artifactContent[artifact.id],
      onAppear: { Task { await onLoadArtifact(artifact) } },
      onOpenImage: { image in
        fullscreenImage = WorkFullscreenImage(title: artifact.title, image: image)
      }
    )
  }
}

struct WorkAssistantMarkdownBlockRow: View, Equatable {
  let model: WorkAssistantMarkdownBlockRenderModel
  let onCopyMessage: () -> Void

  static func == (lhs: WorkAssistantMarkdownBlockRow, rhs: WorkAssistantMarkdownBlockRow) -> Bool {
    lhs.model == rhs.model
  }

  var body: some View {
    WorkMarkdownBlockView(block: model.block)
      .frame(maxWidth: .infinity, alignment: .leading)
      .contextMenu {
        Button(action: onCopyMessage) {
          Label("Copy message", systemImage: "doc.on.doc")
        }
      }
      .accessibilityElement(children: .contain)
      .adeInspectable(
        "Work.Chat.MessageBubble.Assistant.Block",
        metadata: [
          "messageId": model.messageId,
          "turnId": model.turnId ?? "",
          "itemId": model.itemId ?? "",
          "blockId": model.block.id
        ]
      )
  }
}

struct WorkAssistantMonospacedRow: View, Equatable {
  let model: WorkAssistantMonospacedRenderModel
  let onCopyMessage: () -> Void

  static func == (lhs: WorkAssistantMonospacedRow, rhs: WorkAssistantMonospacedRow) -> Bool {
    lhs.model == rhs.model
  }

  var body: some View {
    WorkAssistantMonospacedPreview(text: model.text)
      .accessibilityLabel(model.accessibilityLabel)
      .contextMenu {
        Button(action: onCopyMessage) {
          Label("Copy message", systemImage: "doc.on.doc")
        }
      }
      .adeInspectable(
        "Work.Chat.MessageBubble.Assistant.Monospace",
        metadata: [
          "messageId": model.messageId,
          "turnId": model.turnId ?? "",
          "itemId": model.itemId ?? ""
        ]
      )
  }
}

struct WorkAssistantMessageControlsView: View, Equatable {
  let controls: WorkAssistantMessageControlsModel
  let onCopyMessage: () -> Void
  let onShowMore: () -> Void

  static func == (lhs: WorkAssistantMessageControlsView, rhs: WorkAssistantMessageControlsView) -> Bool {
    lhs.controls == rhs.controls
  }

  var body: some View {
    HStack(spacing: 12) {
      Text(controls.summaryText)
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)

      Spacer(minLength: 0)

      Button(action: onCopyMessage) {
        Label("Copy full", systemImage: "doc.on.doc")
          .labelStyle(.titleAndIcon)
          .font(.caption2.weight(.semibold))
      }
      .buttonStyle(.plain)
      .foregroundStyle(ADEColor.textSecondary)

      if controls.canShowMore {
        Button(action: onShowMore) {
          Label("Show more", systemImage: "chevron.down")
            .labelStyle(.titleAndIcon)
            .font(.caption2.weight(.semibold))
        }
        .buttonStyle(.plain)
        .foregroundStyle(ADEColor.accent)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Assistant response preview. \(controls.visibleLineCount) of \(controls.totalLineCount) lines shown.")
  }
}

// MARK: - Consolidated pending-input strip

extension WorkChatSessionView {
  /// Single consolidated pending-input strip pinned above the composer, matching
  /// the desktop approval card. Replaces the previous split of plan/approval
  /// composer strips plus inline question/permission/model-selection transcript
  /// cards: it renders the current (primary) request, shows a "Request 1 of N"
  /// header and an "Accept all" affordance once more than one request is queued,
  /// and advances to the next request as each is answered (via the optimistic
  /// removal path). Plan-approval keeps its existing compact strip body inside
  /// the switch; only its placement changes.
  /// Composer-anchored section wrapper. Type-erasing the optional pending strip
  /// at a property boundary keeps `composerInset` / `body` under the Swift
  /// type-inference budget (the inline `if let` version tipped `body` over).
  /// The optimistic-answer reconcile also lives here rather than on the giant
  /// `body` VStack — this section is always mounted (it renders empty content
  /// when no request is pending), so the `onChange` stays active while keeping
  /// `body`'s modifier chain small enough to type-check.
  var consolidatedPendingStripSection: some View {
    Group {
      if let primaryPendingInput {
        consolidatedPendingInputStrip(primaryPendingInput)
          .id("pending-strip-\(primaryPendingInput.id)")
      }
    }
    .onChange(of: canonicalPendingInputSignature) { _, _ in
      reconcileOptimisticallyAnsweredInputs()
    }
  }

  @ViewBuilder
  func consolidatedPendingInputStrip(_ item: WorkPendingInputItem) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      if pendingInputCount > 1 {
        pendingInputQueueHeader
      }
      consolidatedPendingInputBody(item)
    }
  }

  /// "Request 1 of N" + optional "Accept all". The primary request is always the
  /// first in the queue, so the leading index is fixed at 1.
  @ViewBuilder
  private var pendingInputQueueHeader: some View {
    HStack(spacing: 8) {
      Text("Request 1 of \(pendingInputCount)")
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
        .accessibilityLabel("Request 1 of \(pendingInputCount) pending.")
      Spacer(minLength: 0)
      if canAcceptAllPendingInputs {
        Button {
          Task { await acceptAllPendingInputs() }
        } label: {
          Text("Accept all")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(ADEColor.accent)
        }
        .buttonStyle(.plain)
        .disabled(actionInFlight || !isLive)
        .accessibilityLabel("Accept all \(acceptAllSweepableInputs.count) pending approvals")
      }
    }
    .padding(.horizontal, 4)
  }

  @ViewBuilder
  private func consolidatedPendingInputBody(_ item: WorkPendingInputItem) -> some View {
    switch item {
    case .planApproval(let model):
      WorkPlanComposerStrip(
        plan: model,
        busy: actionInFlight || !isLive,
        fallbackProvider: chatSummaryContext.provider,
        onDecision: { decision, feedback in
          await dispatchPendingInputAnswer(itemId: model.id) {
            await onApproveRequest(model.id, decision, feedback)
          }
        }
      )
    case .approval(let model):
      WorkApprovalComposerStrip(
        approval: model,
        busy: actionInFlight || !isLive,
        fallbackProvider: chatSummaryContext.provider,
        onDecision: { decision in
          await dispatchPendingInputAnswer(itemId: model.id) {
            await onApproveRequest(model.id, decision, nil)
          }
        }
      )
    case .permission(let model):
      WorkPermissionCard(
        permission: model,
        busy: actionInFlight || !isLive,
        onDecision: { decision in
          await dispatchPendingInputAnswer(itemId: model.id) {
            await onRespondToPermission(model.id, decision)
          }
        }
      )
    case .question(let model):
      WorkStructuredQuestionCard(
        question: model,
        busy: actionInFlight || !isLive,
        onSelectOption: { option, freeform in
          await dispatchPendingInputAnswer(itemId: model.id) {
            await onRespondToQuestion(
              model.id,
              model.questionId,
              .string(option.value),
              freeform
            )
          }
        },
        onSubmitAll: { answers, freeform in
          await dispatchPendingInputAnswer(itemId: model.id) {
            await onSubmitQuestionAnswers(model.id, answers, freeform)
          }
        },
        onDecline: {
          await dispatchPendingInputAnswer(itemId: model.id) {
            await onDeclineQuestion(model.id)
          }
        },
        fallbackProvider: chatSummaryContext.provider
      )
    case .modelSelection(let model):
      WorkModelSelectionPendingCard(
        request: model,
        busy: actionInFlight || !isLive,
        onConfirm: { selectionJSON in
          await dispatchPendingInputAnswer(itemId: model.id) {
            await onSubmitQuestionAnswers(
              model.id,
              ["selection": .string(selectionJSON)],
              nil
            )
          }
        },
        onCancel: {
          await dispatchPendingInputAnswer(itemId: model.id) {
            await onDeclineQuestion(model.id)
          }
        }
      )
    }
  }
}
