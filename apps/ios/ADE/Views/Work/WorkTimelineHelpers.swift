import SwiftUI
import UIKit
import AVKit

func buildWorkTimeline(
  transcript: [WorkChatEnvelope],
  fallbackEntries: [AgentChatTranscriptEntry],
  toolCards: [WorkToolCardModel],
  commandCards: [WorkCommandCardModel],
  fileChangeCards: [WorkFileChangeCardModel],
  eventCards: [WorkEventCardModel],
  artifacts: [ComputerUseArtifactSummary],
  localEchoMessages: [WorkLocalEchoMessage]
) -> [WorkTimelineEntry] {
  let messages = transcript.isEmpty && !fallbackEntries.isEmpty
    ? fallbackEntries.map {
        WorkChatMessage(
          id: "fallback-\($0.id)",
          role: $0.role,
          markdown: $0.text,
          timestamp: $0.timestamp,
          turnId: $0.turnId,
          itemId: nil
        )
      }
    : buildWorkChatMessages(from: transcript)

  var entries: [WorkTimelineEntry] = messages.enumerated().map { index, message in
    WorkTimelineEntry(id: "message-\(message.id)", timestamp: message.timestamp, rank: index, payload: .message(message))
  }

  entries.append(contentsOf: toolCards.enumerated().map { index, card in
    WorkTimelineEntry(id: "tool-\(card.id)", timestamp: card.startedAt, rank: 1_000 + index, payload: .toolCard(card))
  })

  entries.append(contentsOf: commandCards.enumerated().map { index, card in
    WorkTimelineEntry(id: "command-\(card.id)", timestamp: card.timestamp, rank: 1_250 + index, payload: .commandCard(card))
  })

  entries.append(contentsOf: fileChangeCards.enumerated().map { index, card in
    WorkTimelineEntry(id: "file-change-\(card.id)", timestamp: card.timestamp, rank: 1_375 + index, payload: .fileChangeCard(card))
  })

  entries.append(contentsOf: eventCards.enumerated().map { index, card in
    WorkTimelineEntry(id: "event-\(card.id)", timestamp: card.timestamp, rank: 1_500 + index, payload: .eventCard(card))
  })

  entries.append(contentsOf: artifacts.enumerated().map { index, artifact in
    WorkTimelineEntry(id: "artifact-\(artifact.id)", timestamp: artifact.createdAt, rank: 2_000 + index, payload: .artifact(artifact))
  })

  entries.append(contentsOf: localEchoMessages.enumerated().map { index, echo in
    let message = WorkChatMessage(id: echo.id, role: "user", markdown: echo.text, timestamp: echo.timestamp, turnId: nil, itemId: nil)
    return WorkTimelineEntry(id: "echo-\(echo.id)", timestamp: echo.timestamp, rank: 3_000 + index, payload: .message(message))
  })

  return entries.sorted { lhs, rhs in
    if lhs.timestamp == rhs.timestamp {
      return lhs.rank < rhs.rank
    }
    return lhs.timestamp < rhs.timestamp
  }
}

func buildWorkCommandCards(from transcript: [WorkChatEnvelope]) -> [WorkCommandCardModel] {
  transcript.compactMap { envelope in
    guard case .command(let command, let cwd, let output, let status, let itemId, let exitCode, let durationMs, _) = envelope.event else {
      return nil
    }
    return WorkCommandCardModel(
      id: itemId,
      command: command,
      cwd: cwd,
      output: output,
      status: status,
      timestamp: envelope.timestamp,
      exitCode: exitCode,
      durationMs: durationMs
    )
  }
}

func buildWorkFileChangeCards(from transcript: [WorkChatEnvelope]) -> [WorkFileChangeCardModel] {
  transcript.compactMap { envelope in
    guard case .fileChange(let path, let diff, let kind, let status, let itemId, _) = envelope.event else {
      return nil
    }
    return WorkFileChangeCardModel(
      id: itemId,
      path: path,
      diff: diff,
      kind: kind,
      status: status,
      timestamp: envelope.timestamp
    )
  }
}

func buildWorkEventCards(from transcript: [WorkChatEnvelope]) -> [WorkEventCardModel] {
  transcript.compactMap { envelope in
    switch envelope.event {
    case .activity(let kind, let detail, _):
      return WorkEventCardModel(
        id: envelope.id,
        kind: "activity",
        title: activityTitle(for: kind),
        icon: "bolt.horizontal.circle.fill",
        tint: .accent,
        timestamp: envelope.timestamp,
        body: detail,
        bullets: [],
        metadata: [kind.replacingOccurrences(of: "_", with: " ").capitalized]
      )
    case .plan(let steps, let explanation, _):
      return WorkEventCardModel(
        id: envelope.id,
        kind: "plan",
        title: "Plan",
        icon: "list.bullet.clipboard",
        tint: .accent,
        timestamp: envelope.timestamp,
        body: explanation,
        bullets: steps,
        metadata: []
      )
    case .reasoning(let text, _):
      return WorkEventCardModel(
        id: envelope.id,
        kind: "reasoning",
        title: "Reasoning",
        icon: "brain.head.profile",
        tint: .secondary,
        timestamp: envelope.timestamp,
        body: text,
        bullets: [],
        metadata: []
      )
    case .approvalRequest(let description, let detail, _, _):
      return WorkEventCardModel(
        id: envelope.id,
        kind: "approval",
        title: "Approval needed",
        icon: "checkmark.shield",
        tint: .warning,
        timestamp: envelope.timestamp,
        body: description,
        bullets: detail.map { [$0] } ?? [],
        metadata: []
      )
    case .pendingInputResolved(_, let resolution, _):
      return WorkEventCardModel(
        id: envelope.id,
        kind: "pendingInputResolved",
        title: "Input resolved",
        icon: pendingInputResolutionIcon(for: resolution),
        tint: pendingInputResolutionTint(for: resolution),
        timestamp: envelope.timestamp,
        body: nil,
        bullets: [],
        metadata: [pendingInputResolutionLabel(for: resolution)]
      )
    case .structuredQuestion(let question, let options, _, _):
      return WorkEventCardModel(
        id: envelope.id,
        kind: "question",
        title: "Question",
        icon: "questionmark.circle",
        tint: .warning,
        timestamp: envelope.timestamp,
        body: question,
        bullets: options,
        metadata: []
      )
    case .todoUpdate(let items, _):
      return WorkEventCardModel(
        id: envelope.id,
        kind: "todo",
        title: "Todo update",
        icon: "checklist",
        tint: .accent,
        timestamp: envelope.timestamp,
        body: nil,
        bullets: items,
        metadata: []
      )
    case .systemNotice(let kind, let message, let detail, _, _):
      return WorkEventCardModel(
        id: envelope.id,
        kind: "notice",
        title: noticeTitle(for: kind),
        icon: noticeIcon(for: kind),
        tint: noticeTint(for: kind),
        timestamp: envelope.timestamp,
        body: message,
        bullets: detail.map { [$0] } ?? [],
        metadata: [kind.replacingOccurrences(of: "_", with: " ").capitalized]
      )
    case .error(let message, let detail, let category, _):
      let errorStyle = errorPresentation(for: category)
      return WorkEventCardModel(
        id: envelope.id,
        kind: "error",
        title: errorStyle.title,
        icon: errorStyle.icon,
        tint: errorStyle.tint,
        timestamp: envelope.timestamp,
        body: message,
        bullets: detail.map { [$0] } ?? [],
        metadata: [category.replacingOccurrences(of: "_", with: " ").capitalized]
      )
    case .done(let status, let summary, _, _):
      return WorkEventCardModel(
        id: envelope.id,
        kind: "done",
        title: "Turn finished",
        icon: status == "completed" ? "checkmark.circle.fill" : status == "failed" ? "xmark.circle.fill" : "pause.circle.fill",
        tint: status == "completed" ? .success : status == "failed" ? .danger : .warning,
        timestamp: envelope.timestamp,
        body: summary.isEmpty ? nil : summary,
        bullets: [],
        metadata: [status.replacingOccurrences(of: "_", with: " ").capitalized]
      )
    case .promptSuggestion(let text, _):
      return WorkEventCardModel(
        id: envelope.id,
        kind: "promptSuggestion",
        title: "Suggested next prompt",
        icon: "lightbulb",
        tint: .accent,
        timestamp: envelope.timestamp,
        body: text,
        bullets: [],
        metadata: []
      )
    case .contextCompact(let summary, _):
      return WorkEventCardModel(
        id: envelope.id,
        kind: "contextCompact",
        title: "Context compacted",
        icon: "rectangle.compress.vertical",
        tint: .secondary,
        timestamp: envelope.timestamp,
        body: summary,
        bullets: [],
        metadata: []
      )
    case .autoApprovalReview(let summary, _):
      return WorkEventCardModel(
        id: envelope.id,
        kind: "autoApproval",
        title: "Auto-approval review",
        icon: "shield.lefthalf.filled",
        tint: .secondary,
        timestamp: envelope.timestamp,
        body: summary,
        bullets: [],
        metadata: []
      )
    case .webSearch(let query, let action, let status, _, _):
      return WorkEventCardModel(
        id: envelope.id,
        kind: "webSearch",
        title: "Web search",
        icon: "globe",
        tint: status == .failed ? .danger : status == .completed ? .success : .warning,
        timestamp: envelope.timestamp,
        body: query,
        bullets: action.map { [$0] } ?? [],
        metadata: [status.rawValue.capitalized]
      )
    case .planText(let text, _):
      return WorkEventCardModel(
        id: envelope.id,
        kind: "planText",
        title: "Plan detail",
        icon: "text.alignleft",
        tint: .accent,
        timestamp: envelope.timestamp,
        body: text,
        bullets: [],
        metadata: []
      )
    case .toolUseSummary(let text, _):
      return WorkEventCardModel(
        id: envelope.id,
        kind: "toolUseSummary",
        title: "Tool use summary",
        icon: "hammer.circle",
        tint: .secondary,
        timestamp: envelope.timestamp,
        body: text,
        bullets: [],
        metadata: []
      )
    case .status(let turnStatus, let message, _):
      return WorkEventCardModel(
        id: envelope.id,
        kind: "status",
        title: "Turn status",
        icon: workChatStatusIcon(turnStatus == "started" ? "active" : turnStatus == "completed" ? "ended" : "idle"),
        tint: turnStatus == "completed" ? .success : turnStatus == "failed" ? .danger : .warning,
        timestamp: envelope.timestamp,
        body: message,
        bullets: [],
        metadata: [turnStatus.replacingOccurrences(of: "_", with: " ").capitalized]
      )
    case .completionReport(let summary, let status, let artifacts, let blockerDescription, _):
      let artifactBullets = artifacts.map { artifact in
        [artifact.type.capitalized, artifact.description, artifact.reference].compactMap { value in
          guard let value, !value.isEmpty else { return nil }
          return value
        }.joined(separator: " · ")
      }
      return WorkEventCardModel(
        id: envelope.id,
        kind: "completionReport",
        title: "Completion report",
        icon: "doc.text.magnifyingglass",
        tint: status == "completed" ? .success : status == "blocked" ? .warning : .secondary,
        timestamp: envelope.timestamp,
        body: [summary, blockerDescription].compactMap { value in
          guard let value, !value.isEmpty else { return nil }
          return value
        }.joined(separator: "\n\n"),
        bullets: artifactBullets,
        metadata: [status.replacingOccurrences(of: "_", with: " ").capitalized]
      )
    default:
      return nil
    }
  }
}

let workTimelinePageSize = 80

func visibleWorkTimelineEntries(from entries: [WorkTimelineEntry], visibleCount: Int) -> [WorkTimelineEntry] {
  let clampedCount = max(visibleCount, 0)
  guard clampedCount < entries.count else { return entries }
  return Array(entries.suffix(clampedCount))
}

func summarizeWorkSessionUsage(from transcript: [WorkChatEnvelope]) -> WorkUsageSummary? {
  let doneEvents = transcript.compactMap { envelope -> WorkUsageSummary? in
    guard case .done(_, _, let usage, _) = envelope.event else { return nil }
    return usage
  }

  let turnCount = transcript.reduce(into: 0) { count, envelope in
    if case .done = envelope.event {
      count += 1
    }
  }

  guard turnCount > 0 else { return nil }

  return doneEvents.reduce(
    WorkUsageSummary(
      turnCount: turnCount,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0
    )
  ) { partial, usage in
    WorkUsageSummary(
      turnCount: partial.turnCount,
      inputTokens: partial.inputTokens + usage.inputTokens,
      outputTokens: partial.outputTokens + usage.outputTokens,
      cacheReadTokens: partial.cacheReadTokens + usage.cacheReadTokens,
      cacheCreationTokens: partial.cacheCreationTokens + usage.cacheCreationTokens,
      costUsd: partial.costUsd + usage.costUsd
    )
  }
}

func makeWorkUsageSummary(
  inputTokens: Int?,
  outputTokens: Int?,
  cacheReadTokens: Int?,
  cacheCreationTokens: Int?,
  costUsd: Double?
) -> WorkUsageSummary? {
  guard inputTokens != nil || outputTokens != nil || cacheReadTokens != nil || cacheCreationTokens != nil || costUsd != nil else {
    return nil
  }

  return WorkUsageSummary(
    turnCount: 1,
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheCreationTokens: cacheCreationTokens ?? 0,
    costUsd: costUsd ?? 0
  )
}

func formattedTokenCount(_ value: Int) -> String {
  let formatter = NumberFormatter()
  formatter.numberStyle = .decimal
  return formatter.string(from: NSNumber(value: value)) ?? String(value)
}

func formattedDuration(milliseconds: Int) -> String {
  if milliseconds < 1_000 {
    return "\(milliseconds) ms"
  }

  let seconds = Double(milliseconds) / 1_000
  if seconds < 60 {
    return String(format: "%.1fs", seconds)
  }

  let minutes = Int(seconds) / 60
  let remainingSeconds = Int(seconds) % 60
  return "\(minutes)m \(remainingSeconds)s"
}

func diffLineColor(for line: String) -> Color {
  if line.hasPrefix("+") && !line.hasPrefix("+++") {
    return ADEColor.success
  }
  if line.hasPrefix("-") && !line.hasPrefix("---") {
    return ADEColor.danger
  }
  return ADEColor.textPrimary
}

func diffLineBackground(for line: String) -> Color {
  if line.hasPrefix("+") && !line.hasPrefix("+++") {
    return ADEColor.success.opacity(0.12)
  }
  if line.hasPrefix("-") && !line.hasPrefix("---") {
    return ADEColor.danger.opacity(0.12)
  }
  return .clear
}

func workErrorCategory(message: String, detail: String?) -> String {
  let haystack = "\(message)\n\(detail ?? "")".lowercased()
  if haystack.contains("auth") || haystack.contains("unauthorized") || haystack.contains("forbidden") || haystack.contains("login") {
    return "auth"
  }
  if haystack.contains("rate limit") || haystack.contains("429") || haystack.contains("quota") || haystack.contains("too many requests") {
    return "rate_limit"
  }
  if haystack.contains("timeout") || haystack.contains("offline") || haystack.contains("network") || haystack.contains("disconnected") {
    return "network"
  }
  if haystack.contains("permission") || haystack.contains("denied") {
    return "permission"
  }
  return "general"
}
