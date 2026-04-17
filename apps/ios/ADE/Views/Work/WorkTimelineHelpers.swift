import SwiftUI
import UIKit
import AVKit

func buildWorkChatTimelineSnapshot(
  transcript: [WorkChatEnvelope],
  fallbackEntries: [AgentChatTranscriptEntry],
  artifacts: [ComputerUseArtifactSummary],
  localEchoMessages: [WorkLocalEchoMessage]
) -> WorkChatTimelineSnapshot {
  let pendingInputs = derivePendingWorkInputs(from: transcript)
  let pendingSteers = derivePendingWorkSteers(from: transcript)
  let toolCards = buildWorkToolCards(from: transcript)
  let eventCards = buildWorkEventCards(from: transcript)
  let commandCards = buildWorkCommandCards(from: transcript)
  let fileChangeCards = buildWorkFileChangeCards(from: transcript)
  let subagentSnapshots = buildWorkSubagentSnapshots(from: transcript)
  let timeline = buildWorkTimeline(
    transcript: transcript,
    fallbackEntries: fallbackEntries,
    toolCards: toolCards,
    commandCards: commandCards,
    fileChangeCards: fileChangeCards,
    eventCards: eventCards,
    artifacts: artifacts,
    localEchoMessages: localEchoMessages
  )

  return WorkChatTimelineSnapshot(
    pendingInputs: pendingInputs,
    pendingSteers: pendingSteers,
    toolCards: toolCards,
    eventCards: eventCards,
    commandCards: commandCards,
    fileChangeCards: fileChangeCards,
    subagentSnapshots: subagentSnapshots,
    timeline: timeline
  )
}

/// Collapse `subagent_*` events into one snapshot per taskId. Preserves host
/// order via a first-seen index so completed subagents don't jump around when
/// a later progress event lands.
func buildWorkSubagentSnapshots(from transcript: [WorkChatEnvelope]) -> [WorkSubagentSnapshot] {
  struct Entry {
    var snapshot: WorkSubagentSnapshot
    var order: Int
  }
  var entries: [String: Entry] = [:]
  var next = 0

  func place(_ taskId: String, _ snapshot: WorkSubagentSnapshot) {
    if let existing = entries[taskId] {
      entries[taskId] = Entry(snapshot: snapshot, order: existing.order)
    } else {
      entries[taskId] = Entry(snapshot: snapshot, order: next)
      next += 1
    }
  }

  for envelope in transcript {
    switch envelope.event {
    case .subagentStarted(let taskId, let description, let background, let turnId):
      place(taskId, WorkSubagentSnapshot(
        taskId: taskId,
        description: description,
        background: background,
        status: .running,
        lastToolName: entries[taskId]?.snapshot.lastToolName,
        latestSummary: entries[taskId]?.snapshot.latestSummary,
        turnId: turnId
      ))
    case .subagentProgress(let taskId, let description, let summary, let toolName, let turnId):
      let existing = entries[taskId]?.snapshot
      place(taskId, WorkSubagentSnapshot(
        taskId: taskId,
        description: description ?? existing?.description ?? "Subagent",
        background: existing?.background ?? false,
        status: .running,
        lastToolName: toolName ?? existing?.lastToolName,
        latestSummary: summary.isEmpty ? existing?.latestSummary : summary,
        turnId: turnId ?? existing?.turnId
      ))
    case .subagentResult(let taskId, let status, let summary, let turnId):
      let normalized: WorkSubagentSnapshot.Status = {
        switch status.lowercased() {
        case "failed", "error", "cancelled", "canceled": return .failed
        default: return .succeeded
        }
      }()
      let existing = entries[taskId]?.snapshot
      place(taskId, WorkSubagentSnapshot(
        taskId: taskId,
        description: existing?.description ?? "Subagent",
        background: existing?.background ?? false,
        status: normalized,
        lastToolName: existing?.lastToolName,
        latestSummary: summary.isEmpty ? existing?.latestSummary : summary,
        turnId: turnId ?? existing?.turnId
      ))
    default:
      break
    }
  }

  return entries.values
    .sorted { $0.order < $1.order }
    .map { $0.snapshot }
}

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
  let transcriptUserMessageTexts = Set(
    messages
      .filter { $0.role.lowercased() == "user" }
      .map { normalizedWorkLocalEchoText($0.markdown) }
      .filter { !$0.isEmpty }
  )
  let visibleLocalEchoMessages = localEchoMessages.filter { echo in
    !transcriptUserMessageTexts.contains(normalizedWorkLocalEchoText(echo.text))
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

  let turnUsageSummaries = transcript.compactMap { envelope -> (id: String, timestamp: String, usage: WorkUsageSummary)? in
    guard case .done(_, _, let usage, _) = envelope.event, let usage else { return nil }
    return (envelope.id, envelope.timestamp, usage)
  }

  entries.append(contentsOf: turnUsageSummaries.enumerated().map { index, item in
    WorkTimelineEntry(
      id: "usage-\(item.id)",
      timestamp: item.timestamp,
      rank: 1_650 + index,
      payload: .usageSummary(item.usage)
    )
  })

  entries.append(contentsOf: artifacts.enumerated().map { index, artifact in
    WorkTimelineEntry(id: "artifact-\(artifact.id)", timestamp: artifact.createdAt, rank: 2_000 + index, payload: .artifact(artifact))
  })

  entries.append(contentsOf: visibleLocalEchoMessages.enumerated().map { index, echo in
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

func normalizedWorkLocalEchoText(_ text: String) -> String {
  text
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
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
      guard !isLowSignalWorkActivity(kind: kind, detail: detail) else { return nil }
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
        bullets: steps.map { $0.text },
        metadata: [],
        planSteps: steps
      )
    case .reasoning(let text, _):
      guard !isLowSignalWorkReasoning(text) else { return nil }
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
      guard !isLowSignalWorkSystemNotice(kind: kind, message: message, detail: detail) else { return nil }
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
    case .done:
      // Usage is rendered as a compact timeline banner near the completed
      // turn. Avoid a generic event card here because the host summary often
      // contains raw JSON.
      return nil
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
      guard !isLowSignalWorkStatus(turnStatus: turnStatus, message: message) else { return nil }
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

func isLowSignalWorkReasoning(_ text: String) -> Bool {
  let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  return normalized.isEmpty || normalized == "thinking through the answer"
}

func isLowSignalWorkActivity(kind: String, detail: String?) -> Bool {
  let normalizedKind = kind.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  let normalizedDetail = detail?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
  return normalizedKind == "thinking" && (normalizedDetail.isEmpty || normalizedDetail == "thinking through the answer")
}

func isLowSignalWorkSystemNotice(kind: String, message: String, detail: String?) -> Bool {
  let normalizedKind = kind.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  let normalizedMessage = message.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  let normalizedDetail = detail?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  return normalizedDetail.isEmpty
    && (normalizedKind.isEmpty || normalizedKind == "info")
    && (normalizedMessage == "session ready" || normalizedMessage == "ready")
}

func isLowSignalWorkStatus(turnStatus: String, message: String?) -> Bool {
  let normalizedStatus = turnStatus.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  let normalizedMessage = message?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  return normalizedMessage.isEmpty && (normalizedStatus == "started" || normalizedStatus == "completed")
}

let workTimelinePageSize = 80

func visibleWorkTimelineEntries(from entries: [WorkTimelineEntry], visibleCount: Int) -> [WorkTimelineEntry] {
  let clampedCount = max(visibleCount, 0)
  guard clampedCount < entries.count else { return entries }
  return Array(entries.suffix(clampedCount))
}

/// Walk a sorted timeline and emit a turn-separator pill before each user
/// message so the transcript reads like the desktop AgentChatPane: a centered
/// "HH:MM AM · Model" label introduces every new turn.
///
/// The separator carries the user-message timestamp and the chat's current
/// model so the assistant message rendered just below it doesn't need its own
/// time/name header.
func injectWorkTurnSeparators(
  into entries: [WorkTimelineEntry],
  chatSummary: AgentChatSessionSummary?
) -> [WorkTimelineEntry] {
  guard !entries.isEmpty else { return entries }
  var seenTurnIds = Set<String>()
  var output: [WorkTimelineEntry] = []
  output.reserveCapacity(entries.count + 4)

  let provider = chatSummary?.provider ?? ""
  let modelLabel = prettyWorkChatModelName(chatSummary?.model ?? "")
  let modelId = chatSummary?.modelId ?? chatSummary?.model

  for entry in entries {
    if case .message(let message) = entry.payload, message.role.lowercased() == "user" {
      // De-dupe by turnId when present; otherwise allow one separator per
      // user message (which is how desktop chunks the transcript).
      let key = message.turnId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "msg-\(message.id)"
      if !seenTurnIds.contains(key) {
        seenTurnIds.insert(key)
        let separator = WorkTurnSeparator(
          time: message.timestamp,
          provider: provider,
          modelLabel: modelLabel,
          modelId: modelId
        )
        // Rank the separator just before the user message at the same
        // timestamp so the sort below stays stable and the separator hugs
        // its turn rather than floating alone.
        output.append(
          WorkTimelineEntry(
            id: "turn-sep-\(key)",
            timestamp: message.timestamp,
            rank: entry.rank - 1,
            payload: .turnSeparator(separator)
          )
        )
      }
    }
    output.append(entry)
  }
  return output
}

/// Beautify a host-supplied model id into the label used on chips and turn
/// separators. Mirrors the desktop composer's display: "Claude Sonnet 4.6",
/// "GPT-5.4-Codex", etc., so iOS and desktop read the same.
func prettyWorkChatModelName(_ raw: String) -> String {
  let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return "Model" }
  switch trimmed.lowercased() {
  case "opus": return "Claude Opus 4.7"
  case "opus[1m]", "opus-1m": return "Claude Opus 4.7 1M"
  case "sonnet": return "Claude Sonnet 4.6"
  case "haiku": return "Claude Haiku 4.5"
  default:
    if trimmed.lowercased().hasPrefix("claude-") {
      return "Claude " + beautifyWorkModelSegment(String(trimmed.dropFirst("claude-".count)))
    }
    return beautifyWorkModelSegment(trimmed)
  }
}

private func beautifyWorkModelSegment(_ raw: String) -> String {
  raw
    .split(separator: "-")
    .map { part -> String in
      let s = String(part)
      if s.range(of: #"^\d+$"#, options: .regularExpression) != nil { return s }
      if s.lowercased() == "gpt" { return "GPT" }
      return s.prefix(1).uppercased() + s.dropFirst()
    }
    .joined(separator: " ")
    .replacingOccurrences(of: #"(\d+) (\d+)"#, with: "$1.$2", options: .regularExpression)
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

func summarizeWorkSessionUsage(from transcript: [WorkChatEnvelope]) -> WorkUsageSummary? {
  var summary = WorkUsageSummary(
    turnCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0
  )

  for envelope in transcript {
    guard case .done(_, _, let usage, _) = envelope.event, let usage else { continue }
    summary.turnCount += usage.turnCount
    summary.inputTokens += usage.inputTokens
    summary.outputTokens += usage.outputTokens
    summary.cacheReadTokens += usage.cacheReadTokens
    summary.cacheCreationTokens += usage.cacheCreationTokens
    summary.costUsd += usage.costUsd
  }

  return summary.turnCount > 0 ? summary : nil
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
