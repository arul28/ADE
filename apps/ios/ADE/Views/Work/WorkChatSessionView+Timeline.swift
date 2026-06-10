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
    guard workChatIsStreaming(
      sessionStatus: sessionStatus,
      isLive: isLive,
      transcriptIndicatesActiveTurn: timelineSnapshot.transcriptIndicatesActiveTurn
    ) else { return nil }
    for entry in timelineSnapshot.timeline.reversed() {
      guard case .message(let message) = entry.payload else { continue }
      return message.role == "assistant" ? message.id : nil
    }
    return nil
  }

  @ViewBuilder
  func timelineEntryView(for entry: WorkTimelineEntry, proxy: ScrollViewProxy) -> some View {
    switch entry.payload {
    case .message(let message):
      WorkChatMessageBubble(
        message: message,
        isStreaming: message.id == streamingAssistantMessageId
      )
    case .toolCard(let toolCard):
      timelineToolCard(toolCard)
    case .eventCard(let card):
      timelineEventCard(card)
    case .usageSummary(let summary):
      WorkTurnUsageSummaryBanner(
        summary: summary,
        provider: chatSummary?.provider,
        modelLabel: chatSummary.map { prettyWorkChatModelName($0.model) }
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
        }
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
    case .pendingPlanApproval(let plan):
      WorkPlanReviewCard(
        plan: plan,
        busy: actionInFlight || !isLive,
        onDecision: { decision, feedback in
          await runSessionAction {
            // Approve: send "accept" decision directly.
            // Reject: send "decline"; if the user typed feedback, also
            // queue it as a follow-up steer message so the agent sees the
            // revision notes in the next turn.
            await onApproveRequest(plan.id, decision)
            if decision == .decline, let feedback, !feedback.isEmpty {
              _ = await onSend(feedback)
            }
          }
        }
      )
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
    // Files panels are open by default (desktop parity); this dedicated collapse
    // set keeps changed-file state distinct from ordinary tool-card expansion.
    WorkChangedFilesPanelView(
      group: group,
      isExpanded: !collapsedChangedFileGroupIds.contains(group.id),
      onToggle: {
        if collapsedChangedFileGroupIds.contains(group.id) {
          collapsedChangedFileGroupIds.remove(group.id)
        } else {
          collapsedChangedFileGroupIds.insert(group.id)
        }
      },
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
    guard isLive, sessionStatus == "active" else { return false }
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
