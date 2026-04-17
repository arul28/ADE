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
    case .artifact(let artifact):
      timelineArtifact(artifact)
    case .turnSeparator(let separator):
      WorkTurnSeparatorView(separator: separator)
    }
  }

  @ViewBuilder
  func timelineToolCard(_ toolCard: WorkToolCardModel) -> some View {
    WorkToolCardView(
      toolCard: toolCard,
      references: extractWorkNavigationTargets(from: [toolCard.argsText, toolCard.resultText].compactMap { $0 }.joined(separator: "\n")),
      isExpanded: toolCard.status == .running || expandedToolCardIds.contains(toolCard.id),
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
