import SwiftUI
import UIKit
import AVKit

extension WorkChatSessionView {
  @ViewBuilder
  func timelineEntryView(for entry: WorkTimelineEntry) -> some View {
    switch entry.payload {
    case .message(let message):
      WorkChatMessageBubble(message: message, isLive: isLatestAssistantMessageLive(message))
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
    case .artifact(let artifact):
      timelineArtifact(artifact)
    case .turnSeparator(let separator):
      WorkTurnSeparatorView(separator: separator)
    case .pendingQuestion(let question):
      if isLive {
        WorkStructuredQuestionCard(
          question: question,
          busy: actionInFlight,
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
          }
        )
      } else {
        ADENoticeCard(
          title: "Host needs your answer",
          message: "Reconnect to respond to this question. The host keeps the session paused until input arrives.",
          icon: "questionmark.circle",
          tint: ADEColor.warning,
          actionTitle: nil,
          action: nil
        )
      }
    case .pendingPermission(let permission):
      if isLive {
        WorkPermissionCard(
          permission: permission,
          busy: actionInFlight,
          onDecision: { decision in
            await runSessionAction {
              await onRespondToPermission(permission.id, decision)
            }
          }
        )
      } else {
        ADENoticeCard(
          title: "Permission request waiting",
          message: "Reconnect to allow or decline this tool's permission gate.",
          icon: "lock.shield",
          tint: ADEColor.warning,
          actionTitle: nil,
          action: nil
        )
      }
    case .pendingPlanApproval(let plan):
      if isLive {
        WorkPlanReviewCard(
          plan: plan,
          busy: actionInFlight,
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
      } else {
        ADENoticeCard(
          title: "Plan approval waiting",
          message: "Reconnect to approve or reject the agent's plan.",
          icon: "list.bullet.clipboard",
          tint: ADEColor.warning,
          actionTitle: nil,
          action: nil
        )
      }
    }
  }

  @ViewBuilder
  func timelineToolGroup(_ group: WorkToolGroupModel) -> some View {
    WorkToolGroupCardView(
      group: group,
      isExpanded: expandedToolCardIds.contains(group.id),
      onToggle: { toggleToolCard(group.id) },
      onOpenFile: { path in
        Task { await onOpenFile(path) }
      },
      onOpenPr: { prNumber in
        Task { await onOpenPr(prNumber) }
      }
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
