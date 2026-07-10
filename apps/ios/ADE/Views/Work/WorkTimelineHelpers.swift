import SwiftUI
import UIKit
import AVKit

func buildWorkChatTimelineSnapshot(
  transcript: [WorkChatEnvelope],
  fallbackEntries: [AgentChatTranscriptEntry],
  artifacts: [ComputerUseArtifactSummary],
  localEchoMessages: [WorkLocalEchoMessage]
) -> WorkChatTimelineSnapshot {
  let signature = workChatTimelineSnapshotSignature(
    transcript: transcript,
    fallbackEntries: fallbackEntries,
    artifacts: artifacts,
    localEchoMessages: localEchoMessages
  )
  let pendingInputs = derivePendingWorkInputs(from: transcript)
  let pendingSteers = derivePendingWorkSteers(from: transcript)
  let suppressedItemIds = Set(pendingInputs.map(\.itemId))
  let suppressedToolItemIds = Set(pendingInputs.map(\.itemId))
  let toolCards = buildWorkMobileTimelineToolCards(from: transcript, suppressedPendingItemIds: suppressedToolItemIds)
    .filter(workMobileShowsToolCardInTimeline)
  let eventCards = buildWorkEventCards(from: transcript, suppressedItemIds: suppressedItemIds)
    .filter { $0.kind != "toolUseSummary" }
  let commandCards: [WorkCommandCardModel] = []
  let fileChangeCards: [WorkFileChangeCardModel] = []
  let subagentSnapshots = buildWorkSubagentSnapshots(from: transcript)
  let subagentTimelineRows = buildWorkSubagentTimelineRows(
    from: transcript,
    snapshots: subagentSnapshots
  )
  let scheduledWorkSnapshots = buildWorkScheduledWorkSnapshots(from: transcript)
  let transcriptIndicatesActiveTurn = workTranscriptIndicatesActiveTurn(transcript)
  let transcriptLatestTurnEnded = workTranscriptLatestTurnEnded(transcript)
  let transcriptHasInterruptibleActivity = WorkActivityIndicator.derivePresentation(from: transcript) != nil
  let latestTranscriptTimestamp = latestWorkTranscriptTimestamp(transcript)
  let timeline = buildWorkTimeline(
    transcript: transcript,
    fallbackEntries: fallbackEntries,
    toolCards: toolCards,
    commandCards: commandCards,
    fileChangeCards: fileChangeCards,
    subagentRows: subagentTimelineRows,
    eventCards: eventCards,
    pendingInputs: pendingInputs,
    artifacts: artifacts,
    localEchoMessages: localEchoMessages
  )

  return WorkChatTimelineSnapshot(
    signature: signature,
    pendingInputs: pendingInputs,
    pendingSteers: pendingSteers,
    toolCards: toolCards,
    eventCards: eventCards,
    commandCards: commandCards,
    fileChangeCards: fileChangeCards,
    subagentSnapshots: subagentSnapshots,
    scheduledWorkSnapshots: scheduledWorkSnapshots,
    transcriptIndicatesActiveTurn: transcriptIndicatesActiveTurn,
    transcriptLatestTurnEnded: transcriptLatestTurnEnded,
    transcriptHasInterruptibleActivity: transcriptHasInterruptibleActivity,
    latestTranscriptTimestamp: latestTranscriptTimestamp,
    latestMessageAssistantId: latestWorkTimelineMessageAssistantId(timeline),
    timeline: timeline
  )
}

private func workChatTimelineSnapshotSignature(
  transcript: [WorkChatEnvelope],
  fallbackEntries: [AgentChatTranscriptEntry],
  artifacts: [ComputerUseArtifactSummary],
  localEchoMessages: [WorkLocalEchoMessage]
) -> Int {
  var hasher = Hasher()
  hasher.combine(transcript.count)
  for envelope in transcript {
    hasher.combine(envelope.sessionId)
    hasher.combine(envelope.timestamp)
    hasher.combine(envelope.sequence ?? Int.min)
    combineOptional(envelope.subagentTaskType, into: &hasher)
    combineOptional(envelope.subagentCommand, into: &hasher)
    combineWorkChatEventSignature(envelope.event, into: &hasher)
  }

  if transcript.isEmpty {
    hasher.combine(fallbackEntries.count)
    for entry in fallbackEntries {
      hasher.combine(entry.role)
      combineLongTextSignature(entry.text, into: &hasher)
      hasher.combine(entry.timestamp)
      combineOptional(entry.turnId, into: &hasher)
      combineOptional(entry.messageId, into: &hasher)
      combineOptional(entry.itemId, into: &hasher)
    }
  } else {
    hasher.combine(0)
  }

  hasher.combine(artifacts.count)
  for artifact in artifacts {
    hasher.combine(artifact.id)
    hasher.combine(artifact.artifactKind)
    hasher.combine(artifact.backendStyle)
    hasher.combine(artifact.backendName)
    combineOptional(artifact.sourceToolName, into: &hasher)
    combineOptional(artifact.originalType, into: &hasher)
    hasher.combine(artifact.title)
    combineOptional(artifact.description, into: &hasher)
    hasher.combine(artifact.uri)
    hasher.combine(artifact.storageKind)
    combineOptional(artifact.mimeType, into: &hasher)
    combineOptional(artifact.metadataJson, into: &hasher)
    hasher.combine(artifact.createdAt)
    hasher.combine(artifact.ownerKind)
    hasher.combine(artifact.ownerId)
    hasher.combine(artifact.relation)
    combineOptional(artifact.reviewState, into: &hasher)
    combineOptional(artifact.workflowState, into: &hasher)
    combineOptional(artifact.reviewNote, into: &hasher)
  }

  hasher.combine(localEchoMessages.count)
  for echo in localEchoMessages {
    hasher.combine(echo.id)
    combineLongTextSignature(echo.text, into: &hasher)
    hasher.combine(echo.timestamp)
    combineOptional(echo.deliveryState, into: &hasher)
    hasher.combine(echo.attachments?.count ?? 0)
    for attachment in echo.attachments ?? [] {
      hasher.combine(attachment.path)
      hasher.combine(attachment.type)
      combineOptional(attachment.url, into: &hasher)
    }
  }

  return hasher.finalize()
}

private func combineWorkChatEventSignature(_ event: WorkChatEvent, into hasher: inout Hasher) {
  hasher.combine(event.typeKey)
  switch event {
  case .userMessage(let text, let attachments, let turnId, let steerId, let deliveryState, let processed):
    combineLongTextSignature(text, into: &hasher)
    combineAgentChatFileRefs(attachments, into: &hasher)
    combineOptional(turnId, into: &hasher)
    combineOptional(steerId, into: &hasher)
    combineOptional(deliveryState, into: &hasher)
    combineOptional(processed, into: &hasher)
  case .assistantText(let text, let turnId, let itemId):
    combineLongTextSignature(text, into: &hasher)
    combineOptional(turnId, into: &hasher)
    combineOptional(itemId, into: &hasher)
  case .toolCall(let tool, let argsText, let itemId, let parentItemId, let turnId):
    hasher.combine(tool)
    combineLongTextSignature(argsText, into: &hasher)
    hasher.combine(itemId)
    combineOptional(parentItemId, into: &hasher)
    combineOptional(turnId, into: &hasher)
  case .toolResult(let tool, let resultText, let itemId, let parentItemId, let turnId, let status):
    hasher.combine(tool)
    combineLongTextSignature(resultText, into: &hasher)
    hasher.combine(itemId)
    combineOptional(parentItemId, into: &hasher)
    combineOptional(turnId, into: &hasher)
    hasher.combine(status.rawValue)
  case .activity(let kind, let detail, let turnId):
    hasher.combine(kind)
    combineOptionalText(detail, into: &hasher)
    combineOptional(turnId, into: &hasher)
  case .plan(let steps, let explanation, let turnId):
    combinePlanSteps(steps, into: &hasher)
    combineOptionalText(explanation, into: &hasher)
    combineOptional(turnId, into: &hasher)
  case .subagentStarted(let taskId, let agentId, let agentType, let parentToolUseId, let description, let background, let label, let model, let reasoningEffort, let turnId):
    hasher.combine(taskId)
    combineOptional(agentId, into: &hasher)
    combineOptional(agentType, into: &hasher)
    combineOptional(parentToolUseId, into: &hasher)
    hasher.combine(description)
    hasher.combine(background)
    combineOptionalText(label, into: &hasher)
    combineOptionalText(model, into: &hasher)
    combineOptionalText(reasoningEffort, into: &hasher)
    combineOptional(turnId, into: &hasher)
  case .subagentProgress(let taskId, let agentId, let agentType, let parentToolUseId, let description, let summary, let toolName, let label, let model, let reasoningEffort, let turnId):
    hasher.combine(taskId)
    combineOptional(agentId, into: &hasher)
    combineOptional(agentType, into: &hasher)
    combineOptional(parentToolUseId, into: &hasher)
    combineOptionalText(description, into: &hasher)
    combineLongTextSignature(summary, into: &hasher)
    combineOptional(toolName, into: &hasher)
    combineOptionalText(label, into: &hasher)
    combineOptionalText(model, into: &hasher)
    combineOptionalText(reasoningEffort, into: &hasher)
    combineOptional(turnId, into: &hasher)
  case .subagentResult(let taskId, let agentId, let agentType, let parentToolUseId, let status, let summary, let label, let model, let reasoningEffort, let turnId):
    hasher.combine(taskId)
    combineOptional(agentId, into: &hasher)
    combineOptional(agentType, into: &hasher)
    combineOptional(parentToolUseId, into: &hasher)
    hasher.combine(status)
    combineLongTextSignature(summary, into: &hasher)
    combineOptionalText(label, into: &hasher)
    combineOptionalText(model, into: &hasher)
    combineOptionalText(reasoningEffort, into: &hasher)
    combineOptional(turnId, into: &hasher)
  case .scheduledWorkUpdate(let id, let kind, let status, let origin, let title, let summary, let prompt, let reason, let cron, let nextRunAt, let lastRunAt, let recurring, let durable, let sourceToolUseId, let sourceTaskId, let turnId, let error):
    hasher.combine(id)
    hasher.combine(kind)
    hasher.combine(status)
    combineOptional(origin, into: &hasher)
    combineOptionalText(title, into: &hasher)
    combineOptionalText(summary, into: &hasher)
    combineOptionalText(prompt, into: &hasher)
    combineOptionalText(reason, into: &hasher)
    combineOptional(cron, into: &hasher)
    combineOptional(nextRunAt, into: &hasher)
    combineOptional(lastRunAt, into: &hasher)
    combineOptional(recurring, into: &hasher)
    combineOptional(durable, into: &hasher)
    combineOptional(sourceToolUseId, into: &hasher)
    combineOptional(sourceTaskId, into: &hasher)
    combineOptional(turnId, into: &hasher)
    combineOptionalText(error, into: &hasher)
  case .transcriptRetraction(let messageIds, let reason, let replacementMessageId, let turnId):
    hasher.combine(messageIds.count)
    for messageId in messageIds {
      hasher.combine(messageId)
    }
    combineOptionalText(reason, into: &hasher)
    combineOptional(replacementMessageId, into: &hasher)
    combineOptional(turnId, into: &hasher)
  case .structuredQuestion(let question, let options, let itemId, let turnId):
    combineLongTextSignature(question, into: &hasher)
    combineQuestionOptions(options, into: &hasher)
    hasher.combine(itemId)
    combineOptional(turnId, into: &hasher)
  case .approvalRequest(let description, let detail, let itemId, let turnId):
    combineLongTextSignature(description, into: &hasher)
    combineOptionalText(detail, into: &hasher)
    hasher.combine(itemId)
    combineOptional(turnId, into: &hasher)
  case .pendingInputResolved(let itemId, let resolution, let turnId):
    hasher.combine(itemId)
    combineLongTextSignature(resolution, into: &hasher)
    combineOptional(turnId, into: &hasher)
  case .todoUpdate(let items, let turnId):
    hasher.combine(items.count)
    for item in items {
      combineLongTextSignature(item, into: &hasher)
    }
    combineOptional(turnId, into: &hasher)
  case .systemNotice(let kind, let message, let detail, let turnId, let steerId):
    hasher.combine(kind)
    combineLongTextSignature(message, into: &hasher)
    combineOptionalText(detail, into: &hasher)
    combineOptional(turnId, into: &hasher)
    combineOptional(steerId, into: &hasher)
  case .error(let message, let detail, let category, let turnId):
    combineLongTextSignature(message, into: &hasher)
    combineOptionalText(detail, into: &hasher)
    hasher.combine(category)
    combineOptional(turnId, into: &hasher)
  case .done(let status, let summary, let usage, let turnId, let model, let modelId):
    hasher.combine(status)
    combineLongTextSignature(summary, into: &hasher)
    combineUsageSummary(usage, into: &hasher)
    hasher.combine(turnId)
    combineOptional(model, into: &hasher)
    combineOptional(modelId, into: &hasher)
  case .tokens(let usage, let turnId, let itemId):
    combineUsageSummary(usage, into: &hasher)
    hasher.combine(turnId)
    combineOptional(itemId, into: &hasher)
  case .promptSuggestion(let text, let turnId):
    combineLongTextSignature(text, into: &hasher)
    combineOptional(turnId, into: &hasher)
  case .contextCompact(let summary, let isInProgress, let turnId, let compactionId):
    combineLongTextSignature(summary, into: &hasher)
    hasher.combine(isInProgress)
    combineOptional(turnId, into: &hasher)
    combineOptional(compactionId, into: &hasher)
  case .autoApprovalReview(let summary, let turnId):
    combineLongTextSignature(summary, into: &hasher)
    combineOptional(turnId, into: &hasher)
  case .webSearch(let query, let action, let actions, let status, let itemId, let turnId):
    combineLongTextSignature(query, into: &hasher)
    combineOptionalText(action, into: &hasher)
    actions?.forEach { combineOptionalText($0.url ?? $0.title ?? $0.query ?? $0.queries?.first, into: &hasher) }
    hasher.combine(status.rawValue)
    hasher.combine(itemId)
    combineOptional(turnId, into: &hasher)
  case .codexState(let title, let message, let icon, let turnId):
    combineLongTextSignature(title, into: &hasher)
    combineLongTextSignature(message, into: &hasher)
    hasher.combine(icon)
    combineOptional(turnId, into: &hasher)
  case .codexTurnStalled(let message, let recoveryOptions, let turnId, let sourceSessionId):
    combineLongTextSignature(message, into: &hasher)
    recoveryOptions.forEach { hasher.combine($0) }
    hasher.combine(turnId)
    hasher.combine(sourceSessionId)
  case .planText(let text, let turnId):
    combineLongTextSignature(text, into: &hasher)
    combineOptional(turnId, into: &hasher)
  case .toolUseSummary(let text, let turnId):
    combineLongTextSignature(text, into: &hasher)
    combineOptional(turnId, into: &hasher)
  case .status(let turnStatus, let message, let turnId):
    hasher.combine(turnStatus)
    combineOptionalText(message, into: &hasher)
    combineOptional(turnId, into: &hasher)
  case .reasoning(let text, let turnId, let itemId, let summaryIndex):
    combineLongTextSignature(text, into: &hasher)
    combineOptional(turnId, into: &hasher)
    combineOptional(itemId, into: &hasher)
    combineOptional(summaryIndex, into: &hasher)
  case .completionReport(let summary, let status, let artifacts, let blockerDescription, let turnId):
    combineLongTextSignature(summary, into: &hasher)
    hasher.combine(status)
    combineCompletionArtifacts(artifacts, into: &hasher)
    combineOptionalText(blockerDescription, into: &hasher)
    combineOptional(turnId, into: &hasher)
  case .command(let command, let cwd, let output, let status, let itemId, let exitCode, let durationMs, let turnId):
    combineLongTextSignature(command, into: &hasher)
    hasher.combine(cwd)
    combineLongTextSignature(output, into: &hasher)
    hasher.combine(status.rawValue)
    hasher.combine(itemId)
    combineOptional(exitCode, into: &hasher)
    combineOptional(durationMs, into: &hasher)
    combineOptional(turnId, into: &hasher)
  case .fileChange(let path, let diff, let kind, let status, let itemId, let turnId):
    hasher.combine(path)
    combineLongTextSignature(diff, into: &hasher)
    hasher.combine(kind)
    hasher.combine(status.rawValue)
    hasher.combine(itemId)
    combineOptional(turnId, into: &hasher)
  case .unknown(let type):
    hasher.combine(type)
  }
}

private func combineOptional<Value: Hashable>(_ value: Value?, into hasher: inout Hasher) {
  hasher.combine(value != nil)
  if let value {
    hasher.combine(value)
  }
}

private func combineOptionalText(_ value: String?, into hasher: inout Hasher) {
  hasher.combine(value != nil)
  if let value {
    combineLongTextSignature(value, into: &hasher)
  }
}

private func combineLongTextSignature(_ text: String, into hasher: inout Hasher) {
  let utf8Count = text.utf8.count
  hasher.combine(utf8Count)
  guard utf8Count > 1_024 else {
    hasher.combine(text)
    return
  }
  hasher.combine(text.prefix(512))
  hasher.combine(text.suffix(512))
}

private func combineAgentChatFileRefs(_ refs: [AgentChatFileRef]?, into hasher: inout Hasher) {
  hasher.combine(refs?.count ?? -1)
  for ref in refs ?? [] {
    hasher.combine(ref.path)
    hasher.combine(ref.type)
    combineOptional(ref.url, into: &hasher)
  }
}

private func combinePlanSteps(_ steps: [WorkPlanStep], into hasher: inout Hasher) {
  hasher.combine(steps.count)
  for step in steps {
    combineLongTextSignature(step.text, into: &hasher)
    hasher.combine(step.status)
  }
}

private func combineQuestionOptions(_ options: [WorkPendingQuestionOption], into hasher: inout Hasher) {
  hasher.combine(options.count)
  for option in options {
    combineLongTextSignature(option.label, into: &hasher)
    combineLongTextSignature(option.value, into: &hasher)
    combineOptionalText(option.description, into: &hasher)
    hasher.combine(option.recommended)
    combineOptionalText(option.preview, into: &hasher)
    combineOptionalText(option.previewFormat, into: &hasher)
  }
}

private func combineUsageSummary(_ usage: WorkUsageSummary?, into hasher: inout Hasher) {
  hasher.combine(usage != nil)
  guard let usage else { return }
  hasher.combine(usage.turnCount)
  hasher.combine(usage.inputTokens)
  hasher.combine(usage.outputTokens)
  hasher.combine(usage.cacheReadTokens)
  hasher.combine(usage.cacheCreationTokens)
  hasher.combine(usage.reasoningTokens)
  hasher.combine(usage.totalTokens)
  combineOptional(usage.contextWindow, into: &hasher)
  hasher.combine(usage.costUsd)
}

private func combineCompletionArtifacts(_ artifacts: [WorkCompletionArtifactModel], into hasher: inout Hasher) {
  hasher.combine(artifacts.count)
  for artifact in artifacts {
    hasher.combine(artifact.type)
    combineLongTextSignature(artifact.description, into: &hasher)
    combineOptional(artifact.reference, into: &hasher)
  }
}

private func latestWorkTranscriptTimestamp(_ transcript: [WorkChatEnvelope]) -> String? {
  var latest: String?
  for envelope in sortedWorkChatEnvelopes(transcript) {
    guard !envelope.timestamp.isEmpty else { continue }
    if latest.map({ envelope.timestamp > $0 }) ?? true {
      latest = envelope.timestamp
    }
  }
  return latest
}

private func latestWorkTimelineMessageAssistantId(_ timeline: [WorkTimelineEntry]) -> String? {
  for entry in timeline.reversed() {
    guard case .message(let message) = entry.payload else { continue }
    return message.role == "assistant" ? message.id : nil
  }
  return nil
}

func workTranscriptIndicatesActiveTurn(_ transcript: [WorkChatEnvelope]) -> Bool {
  var activeTurnIds = Set<String>()
  var bootstrapStartOpen = false
  for envelope in transcript {
    switch envelope.event {
    case .status(let turnStatus, _, let turnId):
      switch turnStatus.lowercased() {
      case "started", "active", "running", "inprogress", "in_progress", "in-progress":
        if let turnId, !turnId.isEmpty {
          activeTurnIds.insert(turnId)
          bootstrapStartOpen = false
        } else {
          bootstrapStartOpen = true
        }
      case "completed", "failed", "interrupted", "cancelled", "canceled", "ended":
        if let turnId, !turnId.isEmpty {
          activeTurnIds.remove(turnId)
        } else {
          bootstrapStartOpen = false
        }
      default:
        break
      }
    case .done(_, _, _, let turnId, _, _):
      activeTurnIds.remove(turnId)
      bootstrapStartOpen = false
    default:
      break
    }
  }
  return bootstrapStartOpen || !activeTurnIds.isEmpty
}

func workTranscriptLatestTurnEnded(_ transcript: [WorkChatEnvelope]) -> Bool {
  for envelope in sortedWorkChatEnvelopes(transcript).reversed() {
    switch envelope.event {
    case .done:
      return true
    case .userMessage:
      return false
    case .status(let turnStatus, _, _):
      switch turnStatus.lowercased() {
      case "completed", "failed", "interrupted", "cancelled", "canceled", "ended":
        return true
      case "started", "active", "running", "inprogress", "in_progress", "in-progress":
        return false
      default:
        continue
      }
    default:
      continue
    }
  }
  return false
}

func workChatIsStreaming(
  sessionStatus: String,
  isLive: Bool,
  transcriptIndicatesActiveTurn: Bool,
  liveTurnActiveHint: Bool? = nil,
  transcriptLatestTurnEnded: Bool = false,
  rowEndedAfterLatestTranscript: Bool = false
) -> Bool {
  guard isLive else { return false }
  if sessionStatus == "ended" { return false }
  if rowEndedAfterLatestTranscript { return false }
  if liveTurnActiveHint == false { return false }
  if transcriptIndicatesActiveTurn { return true }
  if liveTurnActiveHint == true { return true }
  if transcriptLatestTurnEnded { return false }
  return sessionStatus == "active"
}

/// Mirrors desktop `chatSubagents.ts` `isBackgroundShellCommand` exactly:
/// background task type plus an absent or literal background agent type.
func isBackgroundShellCommand(taskType: String?, agentType: String?) -> Bool {
  let normalizedTaskType = nonEmptyWorkTimelineText(taskType)?.lowercased()
  let normalizedAgentType = nonEmptyWorkTimelineText(agentType)?.lowercased()
  return normalizedTaskType == "background"
    && (normalizedAgentType == nil || normalizedAgentType == "background")
}

/// Mirrors desktop `chatSubagents.ts` `isRealSubagent`: a real subagent carries
/// a non-background agentType, or an explicit `subagent`/`local_workflow` task
/// type. Bare lifecycle events (no agentType, no taskType) are NOT real
/// subagents and never produce spawn/result timeline rows — the timeline reads
/// raw event fields, so unlike the roster it does not default agentType.
func isRealSubagentTimelineRow(taskType: String?, agentType: String?) -> Bool {
  if isBackgroundShellCommand(taskType: taskType, agentType: agentType) { return false }
  let normalizedTaskType = nonEmptyWorkTimelineText(taskType)?.lowercased()
  let normalizedAgentType = nonEmptyWorkTimelineText(agentType)?.lowercased()
  if let normalizedAgentType, normalizedAgentType != "background" { return true }
  return normalizedTaskType == "subagent" || normalizedTaskType == "local_workflow"
}

/// Mirrors desktop `chatSubagents.ts` placeholder-summary preference so a
/// low-signal lifecycle tick never replaces a real result description.
func isWorkSubagentPlaceholderSummary(_ value: String?) -> Bool {
  guard let value = nonEmptyWorkTimelineText(value) else { return false }
  return value.range(
    of: #"^(status:\s|task updated$)"#,
    options: [.regularExpression, .caseInsensitive]
  ) != nil
}

func preferredWorkSubagentSummary(_ existing: String?, incoming: String?) -> String? {
  let current = nonEmptyWorkTimelineText(existing)
  let next = nonEmptyWorkTimelineText(incoming)
  guard let current else { return next }
  guard let next else { return current }

  let currentIsPlaceholder = isWorkSubagentPlaceholderSummary(current)
  let nextIsPlaceholder = isWorkSubagentPlaceholderSummary(next)
  if currentIsPlaceholder != nextIsPlaceholder {
    return currentIsPlaceholder ? next : current
  }
  if currentIsPlaceholder { return next }
  return next.count >= current.count ? next : current
}

private func longerWorkSubagentText(_ existing: String?, _ incoming: String?) -> String? {
  let current = nonEmptyWorkTimelineText(existing)
  let next = nonEmptyWorkTimelineText(incoming)
  guard let current else { return next }
  guard let next else { return current }
  return next.count > current.count ? next : current
}

struct WorkBackgroundCommandPresentation: Equatable {
  let label: String
  let cwd: String?
}

/// Mirrors desktop `chatScheduledWork.ts` `backgroundCommandLabel`, with cwd
/// extraction from the same leading `cd <path> &&` prefix for the iOS detail.
func workBackgroundCommandPresentation(_ command: String) -> WorkBackgroundCommandPresentation {
  let original = command
    .split(whereSeparator: { $0.isNewline })
    .map(String.init)
    .map(workCollapsedCommandWhitespace)
    .first(where: { !$0.isEmpty }) ?? ""
  guard !original.isEmpty else {
    return WorkBackgroundCommandPresentation(label: "", cwd: nil)
  }

  var label = original
  var cwd: String?
  let cdPattern = #"^cd\s+(?:\"((?:\\.|[^\"])*)\"|'((?:\\.|[^'])*)'|((?:\\.|[^\s&])+?))\s*&&\s*"#
  let environmentPattern = #"^(?:[A-Za-z_][A-Za-z0-9_]*=(?:\"(?:\\.|[^\"])*\"|'(?:\\.|[^'])*'|[^\s]*)\s+)+"#
  let wrapperPattern = #"^(?:nohup|exec)\s+"#

  for _ in 0..<32 {
    let before = label
    if let match = workRegexPrefixMatch(cdPattern, in: label) {
      if cwd == nil {
        cwd = (1...3).compactMap { capture -> String? in
          guard capture < match.numberOfRanges,
                let range = Range(match.range(at: capture), in: label)
          else { return nil }
          return String(label[range])
        }.first
      }
      if let range = Range(match.range, in: label) {
        label.removeSubrange(range)
      }
    }
    label = workRemovingRegexPrefix(environmentPattern, from: label)
    label = workRemovingRegexPrefix(wrapperPattern, from: label)
    label = workCollapsedCommandWhitespace(label)
    if label == before || label.isEmpty { break }
  }

  return WorkBackgroundCommandPresentation(
    label: label.isEmpty ? original : label,
    cwd: nonEmptyWorkTimelineText(cwd)
  )
}

private func workCollapsedCommandWhitespace(_ value: String) -> String {
  value
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
}

private func workRegexPrefixMatch(_ pattern: String, in value: String) -> NSTextCheckingResult? {
  guard let expression = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
    return nil
  }
  return expression.firstMatch(
    in: value,
    range: NSRange(value.startIndex..<value.endIndex, in: value)
  )
}

private func workRemovingRegexPrefix(_ pattern: String, from value: String) -> String {
  guard let match = workRegexPrefixMatch(pattern, in: value),
        let range = Range(match.range, in: value)
  else { return value }
  var result = value
  result.removeSubrange(range)
  return result
}

/// Collapse `subagent_*` events into one snapshot per runtime subagent. Codex
/// can first emit a parent-tool placeholder keyed by `parentToolUseId`, then a
/// real agent row keyed by `agentId`; mirror desktop by adopting that placeholder
/// into the real row instead of rendering both.
func buildWorkSubagentSnapshots(from transcript: [WorkChatEnvelope]) -> [WorkSubagentSnapshot] {
  struct Entry {
    var snapshot: WorkSubagentSnapshot
    var order: Int
  }
  var entries: [String: Entry] = [:]
  var next = 0

  func identityKey(taskId: String, agentId: String?) -> String {
    normalizedWorkSubagentAgentId(agentId) ?? taskId
  }

  let resolvedKeysByParent = buildResolvedWorkSubagentKeysByParent(from: transcript)

  func isParentPlaceholder(_ snapshot: WorkSubagentSnapshot, parentToolUseId: String) -> Bool {
    snapshot.agentId == nil
      && snapshot.taskId == parentToolUseId
      && snapshot.parentToolUseId == parentToolUseId
  }

  func resolve(
    taskId: String,
    agentId: String?,
    parentToolUseId rawParentToolUseId: String?
  ) -> (key: String, existing: WorkSubagentSnapshot?, order: Int?, adoptedPlaceholder: Bool) {
    let key = identityKey(taskId: taskId, agentId: agentId)
    let direct = entries[key]
    let parentToolUseId = normalizedWorkSubagentAgentId(rawParentToolUseId)
    let parentEntry = parentToolUseId.flatMap { entries[$0] }
    let parentResolvedKeys = parentToolUseId.flatMap { resolvedKeysByParent[$0] }
    let canAdoptParentPlaceholder = parentToolUseId.flatMap { parent in
      guard let parentEntry,
            isParentPlaceholder(parentEntry.snapshot, parentToolUseId: parent),
            parentResolvedKeys?.count == 1,
            parentResolvedKeys?.contains(key) == true
      else { return false }
      return true
    } ?? false

    let taskAliasEntry = key != taskId ? entries[taskId] : nil
    let taskAliasIsParentPlaceholder = taskAliasEntry.flatMap { entry in
      parentToolUseId.flatMap { parent in
        taskId == parent && isParentPlaceholder(entry.snapshot, parentToolUseId: parent)
      }
    } ?? false
    let taskAlias = (taskAliasEntry != nil && (!taskAliasIsParentPlaceholder || canAdoptParentPlaceholder))
      ? taskAliasEntry
      : nil
    let adoptParentEntry = taskAlias == nil && canAdoptParentPlaceholder ? parentEntry : nil
    let adoptedPlaceholder = adoptParentEntry != nil || (taskAlias != nil && taskAliasIsParentPlaceholder)

    if taskAlias != nil, key != taskId {
      entries.removeValue(forKey: taskId)
    }
    if adoptParentEntry != nil, let parentToolUseId {
      entries.removeValue(forKey: parentToolUseId)
    } else if let parentToolUseId,
              let parentEntry,
              isParentPlaceholder(parentEntry.snapshot, parentToolUseId: parentToolUseId),
              let parentResolvedKeys,
              parentResolvedKeys.count > 1 {
      entries.removeValue(forKey: parentToolUseId)
    }

    let adopted = direct ?? taskAlias ?? adoptParentEntry
    return (key, adopted?.snapshot, adopted?.order, adoptedPlaceholder)
  }

  func place(_ key: String, _ snapshot: WorkSubagentSnapshot, order preferredOrder: Int? = nil) {
    if let existing = entries[key] {
      entries[key] = Entry(snapshot: snapshot, order: existing.order)
    } else {
      entries[key] = Entry(snapshot: snapshot, order: preferredOrder ?? next)
      if preferredOrder == nil {
        next += 1
      }
    }
  }

  for envelope in transcript {
    switch envelope.event {
    case .subagentStarted(let taskId, let agentId, let agentType, let parentToolUseId, let description, let background, let label, let model, let reasoningEffort, let turnId):
      let resolved = resolve(taskId: taskId, agentId: agentId, parentToolUseId: parentToolUseId)
      let existing = resolved.existing
      place(resolved.key, WorkSubagentSnapshot(
        taskId: taskId,
        agentId: normalizedWorkSubagentAgentId(agentId) ?? existing?.agentId,
        agentType: normalizedWorkSubagentAgentId(agentType) ?? existing?.agentType,
        parentToolUseId: normalizedWorkSubagentAgentId(parentToolUseId) ?? existing?.parentToolUseId,
        description: longerWorkSubagentText(existing?.description, description) ?? "Subagent",
        background: background || (existing?.background ?? false),
        label: trimmedWorkSubagentText(label) ?? existing?.label,
        model: trimmedWorkSubagentText(model) ?? existing?.model,
        reasoningEffort: trimmedWorkSubagentText(reasoningEffort) ?? existing?.reasoningEffort,
        status: .running,
        lastToolName: existing?.lastToolName,
        latestSummary: existing?.latestSummary,
        turnId: turnId ?? existing?.turnId,
        startedAt: existing?.startedAt ?? envelope.timestamp,
        updatedAt: envelope.timestamp,
        taskType: trimmedWorkSubagentText(envelope.subagentTaskType) ?? existing?.taskType,
        command: longerWorkSubagentText(existing?.command, envelope.subagentCommand)
      ), order: resolved.order)
    case .subagentProgress(let taskId, let agentId, let agentType, let parentToolUseId, let description, let summary, let toolName, let label, let model, let reasoningEffort, let turnId):
      let resolved = resolve(taskId: taskId, agentId: agentId, parentToolUseId: parentToolUseId)
      let existing = resolved.existing
      place(resolved.key, WorkSubagentSnapshot(
        taskId: resolved.adoptedPlaceholder ? taskId : existing?.taskId ?? taskId,
        agentId: normalizedWorkSubagentAgentId(agentId) ?? existing?.agentId,
        agentType: normalizedWorkSubagentAgentId(agentType) ?? existing?.agentType,
        parentToolUseId: normalizedWorkSubagentAgentId(parentToolUseId) ?? existing?.parentToolUseId,
        description: longerWorkSubagentText(existing?.description, description) ?? "Subagent",
        background: existing?.background ?? false,
        label: trimmedWorkSubagentText(label) ?? existing?.label,
        model: trimmedWorkSubagentText(model) ?? existing?.model,
        reasoningEffort: trimmedWorkSubagentText(reasoningEffort) ?? existing?.reasoningEffort,
        status: .running,
        lastToolName: toolName ?? existing?.lastToolName,
        latestSummary: preferredWorkSubagentSummary(existing?.latestSummary, incoming: summary),
        turnId: turnId ?? existing?.turnId,
        startedAt: existing?.startedAt ?? envelope.timestamp,
        updatedAt: envelope.timestamp,
        taskType: trimmedWorkSubagentText(envelope.subagentTaskType) ?? existing?.taskType,
        command: longerWorkSubagentText(existing?.command, envelope.subagentCommand)
      ), order: resolved.order)
    case .subagentResult(let taskId, let agentId, let agentType, let parentToolUseId, let status, let summary, let label, let model, let reasoningEffort, let turnId):
      let normalized = workSubagentStatus(from: status)
      let resolved = resolve(taskId: taskId, agentId: agentId, parentToolUseId: parentToolUseId)
      let existing = resolved.existing
      place(resolved.key, WorkSubagentSnapshot(
        taskId: resolved.adoptedPlaceholder ? taskId : existing?.taskId ?? taskId,
        agentId: normalizedWorkSubagentAgentId(agentId) ?? existing?.agentId,
        agentType: normalizedWorkSubagentAgentId(agentType) ?? existing?.agentType,
        parentToolUseId: normalizedWorkSubagentAgentId(parentToolUseId) ?? existing?.parentToolUseId,
        description: existing?.description ?? "Subagent",
        background: existing?.background ?? false,
        label: trimmedWorkSubagentText(label) ?? existing?.label,
        model: trimmedWorkSubagentText(model) ?? existing?.model,
        reasoningEffort: trimmedWorkSubagentText(reasoningEffort) ?? existing?.reasoningEffort,
        status: normalized,
        lastToolName: existing?.lastToolName,
        latestSummary: preferredWorkSubagentSummary(existing?.latestSummary, incoming: summary),
        turnId: turnId ?? existing?.turnId,
        startedAt: existing?.startedAt ?? envelope.timestamp,
        updatedAt: envelope.timestamp,
        taskType: trimmedWorkSubagentText(envelope.subagentTaskType) ?? existing?.taskType,
        command: longerWorkSubagentText(existing?.command, envelope.subagentCommand)
      ), order: resolved.order)
    default:
      break
    }
  }

  return entries.values
    .sorted { $0.order < $1.order }
    .map { $0.snapshot }
}

/// Mirrors desktop `chatSubagents.ts` `deriveSubagentTimelineRows`: lifecycle
/// progress enriches the folded snapshot but never creates a timeline row.
func buildWorkSubagentTimelineRows(
  from transcript: [WorkChatEnvelope],
  snapshots: [WorkSubagentSnapshot]? = nil
) -> [WorkSubagentTimelineRow] {
  let foldedSnapshots = snapshots ?? buildWorkSubagentSnapshots(from: transcript)
  let resolvedKeysByParent = buildResolvedWorkSubagentKeysByParent(from: transcript)
  var positionedRows: [(index: Int, row: WorkSubagentTimelineRow)] = []

  for snapshot in foldedSnapshots {
    let snapshotKeys = Set([
      normalizedWorkSubagentAgentId(snapshot.taskId),
      normalizedWorkSubagentAgentId(snapshot.agentId),
    ].compactMap { $0 })
    let resolvedKey = normalizedWorkSubagentAgentId(snapshot.agentId) ?? snapshot.taskId
    let parent = normalizedWorkSubagentAgentId(snapshot.parentToolUseId)
    let canAdoptParentPlaceholder = parent.flatMap { parent in
      let resolved = resolvedKeysByParent[parent]
      return resolved?.count == 1 && resolved?.contains(resolvedKey) == true
    } ?? false

    var firstStarted: (index: Int, timestamp: String)?
    var firstResult: (index: Int, timestamp: String)?
    var resultSummary: String?

    for (index, envelope) in transcript.enumerated() {
      let taskId: String
      let agentId: String?
      let parentToolUseId: String?
      let isStarted: Bool
      let isResult: Bool
      let summary: String?

      switch envelope.event {
      case .subagentStarted(let value, let agent, _, let parentValue, _, _, _, _, _, _):
        taskId = value
        agentId = agent
        parentToolUseId = parentValue
        isStarted = true
        isResult = false
        summary = nil
      case .subagentProgress:
        continue
      case .subagentResult(let value, let agent, _, let parentValue, _, let valueSummary, _, _, _, _):
        taskId = value
        agentId = agent
        parentToolUseId = parentValue
        isStarted = false
        isResult = true
        summary = valueSummary
      default:
        continue
      }

      let eventKeys = Set([
        normalizedWorkSubagentAgentId(taskId),
        normalizedWorkSubagentAgentId(agentId),
      ].compactMap { $0 })
      let directMatch = !snapshotKeys.isDisjoint(with: eventKeys)
      let normalizedParent = normalizedWorkSubagentAgentId(parentToolUseId)
      let parentPlaceholderMatch = canAdoptParentPlaceholder
        && normalizedWorkSubagentAgentId(agentId) == nil
        && normalizedWorkSubagentAgentId(taskId) == parent
        && normalizedParent == parent
      guard directMatch || parentPlaceholderMatch else { continue }

      if isStarted, firstStarted == nil {
        firstStarted = (index, envelope.timestamp)
      }
      if isResult {
        if firstResult == nil {
          firstResult = (index, envelope.timestamp)
        }
        resultSummary = preferredWorkSubagentSummary(resultSummary, incoming: summary)
      }
    }

    if isBackgroundShellCommand(taskType: snapshot.taskType, agentType: snapshot.agentType) {
      guard snapshot.status != .running, let firstResult else { continue }
      let presentation = workBackgroundCommandPresentation(snapshot.command ?? snapshot.description)
      positionedRows.append((
        firstResult.index,
        WorkSubagentTimelineRow(
          kind: .backgroundCommand,
          snapshot: snapshot,
          timestamp: firstResult.timestamp,
          summary: nil,
          commandLabel: presentation.label.isEmpty ? "Background command" : presentation.label,
          exitLabel: workBackgroundCommandExitLabel(summary: resultSummary, status: snapshot.status)
        )
      ))
      continue
    }

    // Only real subagents (non-background agentType, or subagent/local_workflow
    // task type) produce spawn/result rows. Bare lifecycle events stay in the
    // Chat Info roster but do not clutter the timeline. Mirrors desktop
    // `deriveSubagentTimelineRows` gating on `isRealSubagent`.
    guard isRealSubagentTimelineRow(taskType: snapshot.taskType, agentType: snapshot.agentType) else {
      continue
    }

    if let firstStarted {
      positionedRows.append((
        firstStarted.index,
        WorkSubagentTimelineRow(
          kind: .spawn,
          snapshot: snapshot,
          timestamp: firstStarted.timestamp,
          summary: nil,
          commandLabel: nil,
          exitLabel: nil
        )
      ))
    }
    if let firstResult {
      let visibleSummary = isWorkSubagentPlaceholderSummary(resultSummary) ? nil : resultSummary
      positionedRows.append((
        firstResult.index,
        WorkSubagentTimelineRow(
          kind: .result,
          snapshot: snapshot,
          timestamp: firstResult.timestamp,
          summary: visibleSummary,
          commandLabel: nil,
          exitLabel: nil
        )
      ))
    }
  }

  return positionedRows
    .sorted { lhs, rhs in
      if lhs.index == rhs.index { return lhs.row.id < rhs.row.id }
      return lhs.index < rhs.index
    }
    .map(\.row)
}

private func workBackgroundCommandExitLabel(
  summary: String?,
  status: WorkSubagentSnapshot.Status
) -> String {
  if let summary,
     let match = workRegexPrefixMatch(
       #".*?exit(?:ed)?(?:\s+with)?(?:\s+code)?\s*[:=]?\s*(-?\d+)"#,
       in: summary
     ),
     match.numberOfRanges > 1,
     let range = Range(match.range(at: 1), in: summary) {
    return "exit \(summary[range])"
  }
  switch status {
  case .running: return "running"
  case .succeeded: return "completed"
  case .failed: return "failed"
  case .stopped: return "stopped"
  }
}

func buildWorkScheduledWorkSnapshots(from transcript: [WorkChatEnvelope]) -> [WorkScheduledWorkSnapshot] {
  struct Entry {
    var snapshot: WorkScheduledWorkSnapshot
    var order: Int
  }

  var entries: [String: Entry] = [:]
  var nextOrder = 0
  var terminalTurnEventIndex: [String: Int] = [:]
  var lastNonTerminalUpdateIndex: [String: Int] = [:]

  for (eventIndex, envelope) in transcript.enumerated() {
    switch envelope.event {
    case .done(_, _, _, let turnId, _, _):
      if let key = normalizedWorkTurnId(turnId) {
        terminalTurnEventIndex[key] = eventIndex
      }
    case .status(let turnStatus, _, let turnId):
      let normalized = turnStatus.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      if ["completed", "failed", "interrupted", "cancelled", "canceled", "ended"].contains(normalized),
         let key = normalizedWorkTurnId(turnId) {
        terminalTurnEventIndex[key] = eventIndex
      }
    default:
      break
    }

    guard case .scheduledWorkUpdate(
      let id,
      let kind,
      let status,
      let origin,
      let title,
      let summary,
      let prompt,
      let reason,
      let cron,
      let nextRunAt,
      let lastRunAt,
      let recurring,
      let durable,
      let sourceToolUseId,
      let sourceTaskId,
      let turnId,
      let error
    ) = envelope.event else {
      continue
    }

    let key = id.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !key.isEmpty else { continue }
    let existing = entries[key]
    let displayTitle = nonEmptyWorkTimelineText(title)
      ?? existing?.snapshot.title
      ?? workScheduledWorkDefaultTitle(kind: kind)

    entries[key] = Entry(
      snapshot: WorkScheduledWorkSnapshot(
        id: key,
        kind: kind,
        status: status,
        origin: origin,
        title: displayTitle,
        summary: nonEmptyWorkTimelineText(summary) ?? existing?.snapshot.summary,
        prompt: nonEmptyWorkTimelineText(prompt) ?? existing?.snapshot.prompt,
        reason: nonEmptyWorkTimelineText(reason) ?? existing?.snapshot.reason,
        cron: nonEmptyWorkTimelineText(cron) ?? existing?.snapshot.cron,
        nextRunAt: nonEmptyWorkTimelineText(nextRunAt) ?? existing?.snapshot.nextRunAt,
        lastRunAt: nonEmptyWorkTimelineText(lastRunAt) ?? existing?.snapshot.lastRunAt,
        recurring: recurring ?? existing?.snapshot.recurring,
        durable: durable ?? existing?.snapshot.durable,
        sourceToolUseId: nonEmptyWorkTimelineText(sourceToolUseId) ?? existing?.snapshot.sourceToolUseId,
        sourceTaskId: nonEmptyWorkTimelineText(sourceTaskId) ?? existing?.snapshot.sourceTaskId,
        turnId: nonEmptyWorkTimelineText(turnId) ?? existing?.snapshot.turnId,
        error: nonEmptyWorkTimelineText(error) ?? existing?.snapshot.error,
        createdAt: existing?.snapshot.createdAt ?? envelope.timestamp,
        updatedAt: envelope.timestamp
      ),
      order: existing?.order ?? nextOrder
    )
    if existing == nil {
      nextOrder += 1
    }
    let normalizedStatus = status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if normalizedStatus == "scheduled" || normalizedStatus == "running" {
      lastNonTerminalUpdateIndex[key] = eventIndex
    }
  }

  // Mirrors desktop `chatScheduledWork.ts`: a background process whose parent
  // turn ended after its last running update must not remain live forever.
  for (id, var entry) in entries {
    let snapshot = entry.snapshot
    let normalizedKind = snapshot.kind.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let normalizedStatus = snapshot.status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard normalizedKind == "background_task",
          normalizedStatus == "scheduled" || normalizedStatus == "running",
          let turnId = normalizedWorkTurnId(snapshot.turnId),
          let finishedAt = terminalTurnEventIndex[turnId],
          let lastNonTerminalAt = lastNonTerminalUpdateIndex[id],
          finishedAt > lastNonTerminalAt
    else { continue }
    entry.snapshot.status = "stopped"
    entries[id] = entry
  }

  return entries.values
    .sorted { lhs, rhs in
      if lhs.snapshot.updatedAt == rhs.snapshot.updatedAt {
        return lhs.order < rhs.order
      }
      return lhs.snapshot.updatedAt > rhs.snapshot.updatedAt
    }
    .map(\.snapshot)
}

private func workScheduledWorkDefaultTitle(kind: String) -> String {
  switch kind.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
  case "wakeup":
    return "Scheduled wakeup"
  case "cron":
    return "Scheduled task"
  case "loop":
    return "Loop wakeup"
  case "remote_trigger":
    return "Remote trigger"
  case "background_task":
    return "Background work"
  default:
    return "Scheduled work"
  }
}

/// Mirrors desktop `chatScheduledWork.ts` schedule/background partitioning.
func workChatInfoScheduleItems(
  _ snapshots: [WorkScheduledWorkSnapshot]
) -> [WorkScheduledWorkSnapshot] {
  let scheduleKinds: Set<String> = ["wakeup", "cron", "loop", "remote_trigger"]
  return snapshots.filter {
    scheduleKinds.contains($0.kind.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
  }
}

func workChatInfoBackgroundItems(
  _ snapshots: [WorkScheduledWorkSnapshot]
) -> [WorkScheduledWorkSnapshot] {
  snapshots.filter {
    $0.kind.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "background_task"
  }
}

func workChatInfoSubagents(
  _ snapshots: [WorkSubagentSnapshot]
) -> [WorkSubagentSnapshot] {
  snapshots.filter {
    !isBackgroundShellCommand(taskType: $0.taskType, agentType: $0.agentType)
  }
}

func workChatInfoItemCount(
  subagents: [WorkSubagentSnapshot],
  scheduledWork: [WorkScheduledWorkSnapshot]
) -> Int {
  workChatInfoSubagents(subagents).count
    + workChatInfoBackgroundItems(scheduledWork).count
    + workChatInfoScheduleItems(scheduledWork).count
}

func workBackgroundCommandSource(_ snapshot: WorkScheduledWorkSnapshot) -> String {
  nonEmptyWorkTimelineText(snapshot.prompt)
    ?? nonEmptyWorkTimelineText(snapshot.title)
    ?? nonEmptyWorkTimelineText(snapshot.summary)
    ?? nonEmptyWorkTimelineText(snapshot.reason)
    ?? "Background work"
}

private func buildResolvedWorkSubagentKeysByParent(from transcript: [WorkChatEnvelope]) -> [String: Set<String>] {
  var keysByParent: [String: Set<String>] = [:]
  for envelope in transcript {
    let taskId: String
    let agentId: String?
    let parentToolUseId: String?
    switch envelope.event {
    case .subagentStarted(let value, let agent, _, let parent, _, _, _, _, _, _):
      taskId = value
      agentId = agent
      parentToolUseId = parent
    case .subagentProgress(let value, let agent, _, let parent, _, _, _, _, _, _, _):
      taskId = value
      agentId = agent
      parentToolUseId = parent
    case .subagentResult(let value, let agent, _, let parent, _, _, _, _, _, _):
      taskId = value
      agentId = agent
      parentToolUseId = parent
    default:
      continue
    }
    guard let parent = normalizedWorkSubagentAgentId(parentToolUseId) else { continue }
    let key = normalizedWorkSubagentAgentId(agentId) ?? taskId
    guard key != parent else { continue }
    keysByParent[parent, default: []].insert(key)
  }
  return keysByParent
}

private func normalizedWorkSubagentAgentId(_ value: String?) -> String? {
  let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  return trimmed.isEmpty ? nil : trimmed
}

private func trimmedWorkSubagentText(_ value: String?) -> String? {
  let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  return trimmed.isEmpty ? nil : trimmed
}

func workSubagentStatus(from raw: String) -> WorkSubagentSnapshot.Status {
  switch raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
  case "running", "started", "in_progress": return .running
  case "failed", "error", "cancelled", "canceled": return .failed
  case "stopped", "halted", "interrupted": return .stopped
  default: return .succeeded
  }
}

func workSubagentSnapshot(from remote: SyncService.AgentChatSubagentSnapshot) -> WorkSubagentSnapshot {
  let startedAt = remote.startTimestamp ?? remote.endTimestamp
  let updatedAt = remote.endTimestamp ?? remote.startTimestamp
  return WorkSubagentSnapshot(
    taskId: remote.taskId,
    agentId: normalizedWorkSubagentAgentId(remote.agentId),
    agentType: normalizedWorkSubagentAgentId(remote.agentType),
    parentToolUseId: normalizedWorkSubagentAgentId(remote.parentToolUseId),
    description: remote.description,
    background: remote.background ?? false,
    label: trimmedWorkSubagentText(remote.label),
    model: trimmedWorkSubagentText(remote.model),
    reasoningEffort: trimmedWorkSubagentText(remote.reasoningEffort),
    status: workSubagentStatus(from: remote.status),
    lastToolName: remote.lastToolName,
    latestSummary: remote.finalSummary ?? remote.summary,
    turnId: remote.turnId,
    startedAt: startedAt,
    updatedAt: updatedAt
  )
}

func mergeWorkSubagentSnapshots(
  local: [WorkSubagentSnapshot],
  remote: [WorkSubagentSnapshot]
) -> [WorkSubagentSnapshot] {
  guard !remote.isEmpty else { return local }
  guard !local.isEmpty else { return remote }

  var merged = remote
  var indexByKey: [String: Int] = [:]

  func register(_ snapshot: WorkSubagentSnapshot, at index: Int) {
    for key in workSubagentSnapshotLookupKeys(snapshot) {
      indexByKey[key] = index
    }
  }

  for (index, snapshot) in merged.enumerated() {
    register(snapshot, at: index)
  }

  for snapshot in local {
    let index = workSubagentSnapshotLookupKeys(snapshot)
      .compactMap { indexByKey[$0] }
      .first
    if let index {
      merged[index] = mergedWorkSubagentSnapshot(remote: merged[index], local: snapshot)
      register(merged[index], at: index)
    } else {
      let index = merged.count
      merged.append(snapshot)
      register(snapshot, at: index)
    }
  }

  return merged
}

private func workSubagentSnapshotLookupKeys(_ snapshot: WorkSubagentSnapshot) -> [String] {
  var keys: [String] = []
  for value in [snapshot.agentId, Optional(snapshot.taskId), snapshot.parentToolUseId] {
    guard let key = normalizedWorkSubagentAgentId(value),
          !keys.contains(key)
    else { continue }
    keys.append(key)
  }
  return keys
}

private func mergedWorkSubagentSnapshot(
  remote: WorkSubagentSnapshot,
  local: WorkSubagentSnapshot
) -> WorkSubagentSnapshot {
  WorkSubagentSnapshot(
    taskId: remote.taskId,
    agentId: remote.agentId ?? local.agentId,
    agentType: local.agentType ?? remote.agentType,
    parentToolUseId: remote.parentToolUseId ?? local.parentToolUseId,
    description: preferredWorkSubagentText(remote.description, fallback: local.description) ?? "Subagent",
    background: remote.background || local.background,
    label: preferredWorkSubagentText(remote.label, fallback: local.label),
    model: preferredWorkSubagentText(remote.model, fallback: local.model),
    reasoningEffort: preferredWorkSubagentText(remote.reasoningEffort, fallback: local.reasoningEffort),
    status: mergedWorkSubagentStatus(remote: remote.status, local: local.status),
    lastToolName: local.lastToolName ?? remote.lastToolName,
    latestSummary: preferredWorkSubagentSummary(remote.latestSummary, incoming: local.latestSummary),
    turnId: remote.turnId ?? local.turnId,
    startedAt: remote.startedAt ?? local.startedAt,
    updatedAt: latestWorkSubagentTimestamp(remote.updatedAt, local.updatedAt),
    taskType: local.taskType ?? remote.taskType,
    command: longerWorkSubagentText(remote.command, local.command)
  )
}

private func mergedWorkSubagentStatus(
  remote: WorkSubagentSnapshot.Status,
  local: WorkSubagentSnapshot.Status
) -> WorkSubagentSnapshot.Status {
  if remote != .running { return remote }
  if local != .running { return local }
  return .running
}

private func preferredWorkSubagentText(_ primary: String?, fallback: String?) -> String? {
  let primaryTrimmed = primary?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  if !primaryTrimmed.isEmpty { return primary }
  let fallbackTrimmed = fallback?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  return fallbackTrimmed.isEmpty ? nil : fallback
}

private func preferredWorkSubagentText(_ primary: String, fallback: String) -> String? {
  preferredWorkSubagentText(Optional(primary), fallback: Optional(fallback))
}

private func latestWorkSubagentTimestamp(_ lhs: String?, _ rhs: String?) -> String? {
  guard let lhs else { return rhs }
  guard let rhs else { return lhs }
  let lhsDate = workParsedDate(lhs) ?? .distantPast
  let rhsDate = workParsedDate(rhs) ?? .distantPast
  return rhsDate >= lhsDate ? rhs : lhs
}

func buildWorkTimeline(
  transcript: [WorkChatEnvelope],
  fallbackEntries: [AgentChatTranscriptEntry],
  toolCards: [WorkToolCardModel],
  commandCards: [WorkCommandCardModel],
  fileChangeCards: [WorkFileChangeCardModel],
  subagentRows: [WorkSubagentTimelineRow] = [],
  eventCards: [WorkEventCardModel],
  pendingInputs: [WorkPendingInputItem] = [],
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

  let pendingSteerEchoKeys = Set(
    derivePendingWorkSteers(from: transcript).compactMap { workLocalEchoDedupeKey(text: $0.text, attachments: $0.attachments) }
  )

  var entries: [WorkTimelineEntry] = messages.enumerated().map { index, message in
    WorkTimelineEntry(id: "message-\(message.id)", timestamp: message.timestamp, rank: index, payload: .message(message))
  }
  let transcriptUserMessageEchoKeys = Set(
    messages
      .filter { $0.role.lowercased() == "user" }
      .compactMap { workLocalEchoDedupeKey(text: $0.markdown, attachments: $0.attachments) }
  )
  let visibleLocalEchoMessages = localEchoMessages.filter { echo in
    guard let key = workLocalEchoDedupeKey(text: echo.text, attachments: echo.attachments) else { return true }
    return !transcriptUserMessageEchoKeys.contains(key) && !pendingSteerEchoKeys.contains(key)
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

  entries.append(contentsOf: subagentRows.enumerated().map { index, row in
    WorkTimelineEntry(
      id: row.id,
      timestamp: row.timestamp,
      rank: 1_450 + index,
      payload: .subagent(row)
    )
  })

  entries.append(contentsOf: eventCards.enumerated().map { index, card in
    WorkTimelineEntry(id: "event-\(card.id)", timestamp: card.timestamp, rank: 1_500 + index, payload: .eventCard(card))
  })

  // Pending inputs (approval / question / permission / plan-approval /
  // model-selection) are no longer emitted as inline transcript entries. They
  // render in the single consolidated pending-input strip pinned above the
  // composer (`WorkChatSessionView.consolidatedPendingInputStrip`), matching the
  // desktop approval card. `pendingInputs` still drives `suppressedItemIds`
  // above so the originating tool/approval envelopes stay hidden from the
  // transcript.

  let turnUsageSummaries = transcript.compactMap { envelope -> (id: String, timestamp: String, usage: WorkUsageSummary)? in
    guard case .done(_, _, let usage, _, _, _) = envelope.event, let usage else { return nil }
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

  let turnEndMarkers = workTurnEndMarkers(from: transcript)
  entries.append(contentsOf: turnEndMarkers.enumerated().map { index, marker in
    WorkTimelineEntry(
      id: "turn-end-\(marker.turnId)",
      timestamp: marker.time,
      rank: 1_700 + index,
      payload: .turnEndMarker(marker)
    )
  })

  entries.append(contentsOf: artifacts.enumerated().map { index, artifact in
    WorkTimelineEntry(id: "artifact-\(artifact.id)", timestamp: artifact.createdAt, rank: 2_000 + index, payload: .artifact(artifact))
  })

  entries.append(contentsOf: visibleLocalEchoMessages.enumerated().map { index, echo in
    let message = WorkChatMessage(
      id: echo.id,
      role: "user",
      markdown: echo.text,
      timestamp: echo.timestamp,
      turnId: nil,
      itemId: nil,
      deliveryState: echo.deliveryState,
      attachments: echo.attachments
    )
    return WorkTimelineEntry(id: "echo-\(echo.id)", timestamp: echo.timestamp, rank: 3_000 + index, payload: .message(message))
  })

  let sorted = entries.sorted { lhs, rhs in
    if lhs.timestamp == rhs.timestamp {
      return lhs.rank < rhs.rank
    }
    return lhs.timestamp < rhs.timestamp
  }
  // Defensive guard: `ForEach(visibleTimeline)` relies on unique entry ids, and SwiftUI
  // emits a runtime warning and undefined behavior if two rows share one. Dedup by id,
  // keeping the higher-ranked (i.e. later-bucket) entry on collision so completed tool
  // results win over a duplicate running card.
  var seen: [String: Int] = [:]
  var deduped: [WorkTimelineEntry] = []
  deduped.reserveCapacity(sorted.count)
  for entry in sorted {
    if let existing = seen[entry.id] {
      if entry.rank > deduped[existing].rank {
        deduped[existing] = entry
      }
    } else {
      seen[entry.id] = deduped.count
      deduped.append(entry)
    }
  }
  return collapseActivityPhaseTimelineEntries(
    collapseConsecutiveWorkActivityEntries(collapseConsecutiveWorkToolEntries(deduped))
  )
}

/// Fold tool-like timeline entries (tool cards, commands, file changes) into
/// a single `.toolGroup` entry so the iOS chat mirrors the desktop
/// `work_log_group` behavior — one summary row per cluster instead of N
/// stacked cards that eat the phone viewport.
///
/// Low-signal event cards (status, activity, todo, etc.) do NOT break a tool
/// cluster — Claude and Cursor typically emit reasoning between tool calls, and
/// treating those as soft breaks keeps one tool group per burst. Hard boundaries
/// (messages, turn separators, approvals, pending inputs, usage summaries,
/// turn-end markers, artifacts) flush the cluster so the group never swallows a
/// different turn's work.
func collapseConsecutiveWorkToolEntries(_ entries: [WorkTimelineEntry]) -> [WorkTimelineEntry] {
  var result: [WorkTimelineEntry] = []
  result.reserveCapacity(entries.count)
  var cluster: [WorkTimelineEntry] = []
  var buffered: [WorkTimelineEntry] = []

  func flushCluster() {
    if !cluster.isEmpty {
      let members = cluster.compactMap(workToolGroupMember(from:))
      if members.count == cluster.count {
        let anchor = cluster[0]
        var readOnly: [WorkToolGroupMember] = []
        var codeChange: [WorkToolGroupMember] = []
        for member in members {
          if isCodeChangeMember(member) { codeChange.append(member) }
          else { readOnly.append(member) }
        }
        if !readOnly.isEmpty {
          let groupId = "tool-group:\(anchor.id)"
          result.append(WorkTimelineEntry(
            id: groupId,
            timestamp: anchor.timestamp,
            rank: anchor.rank,
            payload: .toolGroup(WorkToolGroupModel(id: groupId, members: readOnly))
          ))
        }
        if !codeChange.isEmpty {
          let groupId = "files-group:\(anchor.id)"
          let files = aggregateChangedFiles(from: codeChange)
          if !files.isEmpty {
            result.append(WorkTimelineEntry(
              id: groupId,
              timestamp: anchor.timestamp,
              rank: anchor.rank,
              payload: .changedFiles(WorkChangedFilesGroupModel(id: groupId, files: files))
            ))
          } else {
            // Aggregation found no extractable file paths (e.g. all members
            // are tool cards whose argsText didn't include `file_path`). Fall
            // back to a tool-group of the raw code-change members so the
            // activity still surfaces in the timeline rather than vanishing.
            let fallbackId = "tool-group-files:\(anchor.id)"
            result.append(WorkTimelineEntry(
              id: fallbackId,
              timestamp: anchor.timestamp,
              rank: anchor.rank,
              payload: .toolGroup(WorkToolGroupModel(id: fallbackId, members: codeChange))
            ))
          }
        }
      } else {
        // A member kind we don't recognise crept in — fall back to the raw
        // entries so we never silently drop transcript content.
        result.append(contentsOf: cluster)
      }
    }
    result.append(contentsOf: buffered)
    cluster.removeAll(keepingCapacity: true)
    buffered.removeAll(keepingCapacity: true)
  }

  for entry in entries {
    if workToolGroupMember(from: entry) != nil {
      // If we had buffered soft-break events between the previous cluster and
      // this new tool entry, flush them now so they land before the new group
      // rather than being absorbed into it.
      if cluster.isEmpty, !buffered.isEmpty {
        result.append(contentsOf: buffered)
        buffered.removeAll(keepingCapacity: true)
      }
      cluster.append(entry)
    } else if workToolGroupSoftBreak(entry) {
      if cluster.isEmpty {
        result.append(entry)
      } else {
        buffered.append(entry)
      }
    } else {
      flushCluster()
      result.append(entry)
    }
  }
  flushCluster()
  return result
}

private func workToolGroupMember(from entry: WorkTimelineEntry) -> WorkToolGroupMember? {
  switch entry.payload {
  case .toolCard(let card): return .tool(card)
  case .commandCard(let card): return .command(card)
  case .fileChangeCard(let card): return .fileChange(card)
  default: return nil
  }
}

/// Code-change membership: file_change events are always code-change; tool
/// cards route by their tool name (Edit / Write / MultiEdit / etc.). Commands
/// are always read-only since they don't directly mutate files in a way the
/// chat surface can attribute.
private func isCodeChangeMember(_ member: WorkToolGroupMember) -> Bool {
  switch member {
  case .tool(let card): return isCodeChangeToolName(card.toolName)
  case .command: return false
  case .fileChange: return true
  }
}

/// Aggregate the code-change members of a cluster into one `WorkChangedFileEntry`
/// per file path. Diff stats sum across every event that touched the same file;
/// the longest diff payload wins as the canonical text shown when the user
/// expands the row to view changes.
private func aggregateChangedFiles(from members: [WorkToolGroupMember]) -> [WorkChangedFileEntry] {
  struct Pending {
    var path: String
    var kind: String
    var additions: Int
    var deletions: Int
    var diff: String
    var status: WorkToolCardStatus
  }
  var byPath: [String: Pending] = [:]
  var order: [String] = []

  func upsert(path: String, kind: String, diff: String, status: WorkToolCardStatus) {
    let stats = aggregateDiffStats(diff)
    if var existing = byPath[path] {
      existing.additions += stats.additions
      existing.deletions += stats.deletions
      if diff.count > existing.diff.count { existing.diff = diff }
      // Promote to a "still running" status if any contributing event hasn't
      // finished — otherwise prefer the most recent terminal status.
      if status == .running { existing.status = .running }
      else if existing.status != .running { existing.status = status }
      byPath[path] = existing
    } else {
      byPath[path] = Pending(
        path: path,
        kind: kind,
        additions: stats.additions,
        deletions: stats.deletions,
        diff: diff,
        status: status
      )
      order.append(path)
    }
  }

  for member in members {
    switch member {
    case .fileChange(let card):
      upsert(path: card.path, kind: card.kind, diff: card.diff, status: card.status)
    case .tool(let card):
      // Code-change tools (Edit/Write/etc.) don't carry a structured file
      // path on iOS today; their `argsText` may include `file_path` JSON. We
      // skip them here unless we can extract a path — falling back to a
      // deterministic placeholder rather than emitting empty rows.
      if let path = extractCodeChangeFilePath(fromArgsText: card.argsText) {
        upsert(path: path, kind: "modify", diff: "", status: card.status)
      }
    case .command:
      continue
    }
  }

  return order.compactMap { path in
    guard let entry = byPath[path] else { return nil }
    return WorkChangedFileEntry(
      id: path,
      path: entry.path,
      kind: entry.kind,
      additions: entry.additions,
      deletions: entry.deletions,
      diff: entry.diff,
      status: entry.status
    )
  }
}

/// Lightweight `file_path` / `path` extractor for code-change tool argsText.
/// The argsText is pretty-printed JSON so a regex over the canonical key form
/// is good enough — we're only using it to surface the path on the row, not
/// for any execution-critical decision.
private func extractCodeChangeFilePath(fromArgsText argsText: String?) -> String? {
  guard let argsText, !argsText.isEmpty else { return nil }
  let patterns = [#""file_path"\s*:\s*"([^"]+)""#, #""path"\s*:\s*"([^"]+)""#]
  for pattern in patterns {
    if let regex = try? NSRegularExpression(pattern: pattern) {
      let range = NSRange(argsText.startIndex..<argsText.endIndex, in: argsText)
      if let match = regex.firstMatch(in: argsText, range: range), match.numberOfRanges >= 2,
         let pathRange = Range(match.range(at: 1), in: argsText) {
        let value = String(argsText[pathRange])
        if !value.isEmpty { return value }
      }
    }
  }
  return nil
}

/// Soft-break entries don't end a tool cluster — they get buffered and
/// re-emitted after the cluster so micro-events (reasoning, status pings,
/// todo updates, activity beacons) don't stop grouping. All transcript-level
/// boundaries (messages, turn separators, usage, pending inputs, artifacts,
/// completion reports, plans) are hard breaks too.
private func workToolGroupSoftBreak(_ entry: WorkTimelineEntry) -> Bool {
  guard case .eventCard(let card) = entry.payload else { return false }
  switch card.kind {
  case "reasoning", "status", "activity", "activityBundle", "todo", "notice",
       "autoApproval", "pendingInputResolved",
       "promptSuggestion", "toolUseSummary":
    return true
  default:
    return false
  }
}

private func activityPhaseTurnId(for entry: WorkTimelineEntry) -> String? {
  if case .eventCard(let card) = entry.payload, card.kind == "reasoning" {
    let parts = card.id.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
    if let turnIndex = parts.firstIndex(of: "turn"), turnIndex + 1 < parts.count {
      let candidate = parts[turnIndex + 1].trimmingCharacters(in: .whitespacesAndNewlines)
      if !candidate.isEmpty { return candidate }
    }
  }
  return nil
}

private enum ActivityPhaseMemberKind {
  case reasoning
  case work
}

private func activityPhaseMemberKind(for entry: WorkTimelineEntry) -> ActivityPhaseMemberKind? {
  switch entry.payload {
  case .eventCard(let card) where card.kind == "reasoning":
    return .reasoning
  case .toolGroup, .changedFiles:
    return .work
  default:
    return nil
  }
}

private func shouldCollapseActivityPhaseTimeline(
  totalRows: Int,
  reasoningRows: Int,
  workRows: Int
) -> Bool {
  totalRows >= 3 || reasoningRows >= 2 || workRows >= 2
}

private func mergeReasoningTimelineEntries(_ entries: [WorkTimelineEntry]) -> WorkTimelineEntry {
  let cards = entries.compactMap { entry -> WorkEventCardModel? in
    guard case .eventCard(let card) = entry.payload, card.kind == "reasoning" else { return nil }
    return card
  }
  let first = entries[0]
  let last = entries[entries.count - 1]
  let mergedBody = cards
    .compactMap { $0.body?.trimmingCharacters(in: .whitespacesAndNewlines) }
    .filter { !$0.isEmpty }
    .joined(separator: "\n\n---\n\n")
  let anchor = cards.first ?? WorkEventCardModel(
    id: first.id,
    kind: "reasoning",
    title: "Reasoning",
    icon: "brain.head.profile",
    tint: .secondary,
    timestamp: first.timestamp,
    body: nil,
    bullets: [],
    metadata: []
  )
  let mergedCard = WorkEventCardModel(
    id: "activity-phase-reasoning:\(first.id)",
    kind: anchor.kind,
    title: anchor.title,
    icon: anchor.icon,
    tint: anchor.tint,
    timestamp: last.timestamp,
    body: mergedBody.isEmpty ? anchor.body : mergedBody,
    bullets: anchor.bullets,
    metadata: anchor.metadata,
    planSteps: anchor.planSteps,
    isInProgress: cards.contains(where: \.isInProgress),
    questionModel: anchor.questionModel,
    planApprovalModel: anchor.planApprovalModel,
    resolution: anchor.resolution
  )
  return WorkTimelineEntry(
    id: mergedCard.id,
    timestamp: last.timestamp,
    rank: first.rank,
    payload: .eventCard(mergedCard)
  )
}

private func mergeToolGroupTimelineEntries(_ entries: [WorkTimelineEntry]) -> WorkTimelineEntry {
  let groups = entries.compactMap { entry -> WorkToolGroupModel? in
    guard case .toolGroup(let group) = entry.payload else { return nil }
    return group
  }
  let first = entries[0]
  let merged = WorkToolGroupModel(
    id: "activity-phase-tools:\(first.id)",
    members: groups.flatMap(\.members)
  )
  return WorkTimelineEntry(
    id: merged.id,
    timestamp: entries[entries.count - 1].timestamp,
    rank: first.rank,
    payload: .toolGroup(merged)
  )
}

private func mergeChangedFilesTimelineEntries(_ entries: [WorkTimelineEntry]) -> WorkTimelineEntry {
  let groups = entries.compactMap { entry -> WorkChangedFilesGroupModel? in
    guard case .changedFiles(let group) = entry.payload else { return nil }
    return group
  }
  let first = entries[0]
  let merged = WorkChangedFilesGroupModel(
    id: "activity-phase-files:\(first.id)",
    files: groups.flatMap(\.files)
  )
  return WorkTimelineEntry(
    id: merged.id,
    timestamp: entries[entries.count - 1].timestamp,
    rank: first.rank,
    payload: .changedFiles(merged)
  )
}

/// Collapse alternating reasoning + tool activity into merged rows, mirroring
/// desktop `collapseGroupedActivityPhaseRows`.
func collapseActivityPhaseTimelineEntries(_ entries: [WorkTimelineEntry]) -> [WorkTimelineEntry] {
  var result: [WorkTimelineEntry] = []
  result.reserveCapacity(entries.count)
  var index = entries.startIndex

  while index < entries.endIndex {
    let entry = entries[index]
    guard let memberKind = activityPhaseMemberKind(for: entry) else {
      result.append(entry)
      index = entries.index(after: index)
      continue
    }

    var phaseTurnId = activityPhaseTurnId(for: entry)
    var phase: [WorkTimelineEntry] = [entry]
    var reasoningRows = memberKind == .reasoning ? 1 : 0
    var workRows = memberKind == .work ? 1 : 0
    let workFirst = memberKind == .work
    var cursor = entries.index(after: index)

    while cursor < entries.endIndex {
      let next = entries[cursor]
      guard let nextKind = activityPhaseMemberKind(for: next) else { break }
      let nextTurnId = activityPhaseTurnId(for: next)
      if let existingTurnId = phaseTurnId, let nextTurnId, nextTurnId != existingTurnId { break }
      if phaseTurnId == nil, let nextTurnId { phaseTurnId = nextTurnId }
      phase.append(next)
      if nextKind == .reasoning { reasoningRows += 1 } else { workRows += 1 }
      cursor = entries.index(after: cursor)
    }

    if shouldCollapseActivityPhaseTimeline(
      totalRows: phase.count,
      reasoningRows: reasoningRows,
      workRows: workRows
    ) {
      let reasoningEntries = phase.filter { activityPhaseMemberKind(for: $0) == .reasoning }
      let toolGroupEntries = phase.filter {
        if case .toolGroup = $0.payload { return true }
        return false
      }
      let changedFilesEntries = phase.filter {
        if case .changedFiles = $0.payload { return true }
        return false
      }
      let firstWorkEntry = phase.first {
        if case .toolGroup = $0.payload { return true }
        if case .changedFiles = $0.payload { return true }
        return false
      }

      func appendWorkGroups() {
        if case .changedFiles = firstWorkEntry?.payload {
          if !changedFilesEntries.isEmpty { result.append(mergeChangedFilesTimelineEntries(changedFilesEntries)) }
          if !toolGroupEntries.isEmpty { result.append(mergeToolGroupTimelineEntries(toolGroupEntries)) }
        } else {
          if !toolGroupEntries.isEmpty { result.append(mergeToolGroupTimelineEntries(toolGroupEntries)) }
          if !changedFilesEntries.isEmpty { result.append(mergeChangedFilesTimelineEntries(changedFilesEntries)) }
        }
      }

      if workFirst {
        appendWorkGroups()
        if !reasoningEntries.isEmpty { result.append(mergeReasoningTimelineEntries(reasoningEntries)) }
      } else {
        if !reasoningEntries.isEmpty { result.append(mergeReasoningTimelineEntries(reasoningEntries)) }
        appendWorkGroups()
      }
    } else {
      result.append(contentsOf: phase)
    }
    index = cursor
  }

  return result
}

private func collapseConsecutiveWorkActivityEntries(_ entries: [WorkTimelineEntry]) -> [WorkTimelineEntry] {
  var result: [WorkTimelineEntry] = []
  result.reserveCapacity(entries.count)
  var cluster: [WorkTimelineEntry] = []
  var clusterTurnId: String?

  func flushCluster() {
    defer {
      cluster.removeAll(keepingCapacity: true)
      clusterTurnId = nil
    }
    guard cluster.count > 1 else {
      result.append(contentsOf: cluster)
      return
    }
    let cards = cluster.compactMap(workActivityCard(from:))
    guard cards.count == cluster.count, let anchor = cluster.first, let latest = cards.last else {
      result.append(contentsOf: cluster)
      return
    }
    let summaries = cards.map(workActivityCardSummary).filter { !$0.isEmpty }
    let latestSummary = nonEmptyWorkTimelineText(latest.body) ?? summaries.last ?? latest.title
    let body = "\(cards.count) activity updates · \(truncatedWorkTimelineText(latestSummary, limit: 90))"
    let bundle = WorkEventCardModel(
      id: "activity-bundle:\(anchor.id)",
      kind: "activityBundle",
      title: "Activity",
      icon: "sparkles",
      tint: .accent,
      timestamp: latest.timestamp,
      body: body,
      bullets: Array(summaries.prefix(6)),
      metadata: []
    )
    result.append(WorkTimelineEntry(
      id: "activity-bundle:\(anchor.id)",
      timestamp: anchor.timestamp,
      rank: anchor.rank,
      payload: .eventCard(bundle)
    ))
  }

  for entry in entries {
    if let card = workActivityCard(from: entry) {
      let turnId = workActivityCardTurnId(from: card)
      if !cluster.isEmpty && (clusterTurnId == nil || turnId == nil || clusterTurnId != turnId) {
        flushCluster()
      }
      if cluster.isEmpty {
        clusterTurnId = turnId
      }
      cluster.append(entry)
    } else {
      flushCluster()
      result.append(entry)
    }
  }
  flushCluster()
  return result
}

private func workActivityCard(from entry: WorkTimelineEntry) -> WorkEventCardModel? {
  guard case .eventCard(let card) = entry.payload else { return nil }
  switch card.kind {
  case "activity", "todo": return card
  default: return nil
  }
}

private func workActivityCardId(sessionId: String, turnId: String?, fallback: String) -> String {
  guard let turnId = normalizedWorkTurnId(turnId) else { return fallback }
  return "\(fallback):activityTurn:\(sessionId):\(turnId)"
}

private func workActivityCardTurnId(from card: WorkEventCardModel) -> String? {
  let parts = card.id.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
  guard let markerIndex = parts.firstIndex(of: "activityTurn"), markerIndex + 2 < parts.count else {
    return nil
  }
  return normalizedWorkTurnId(parts[markerIndex + 2])
}

private func workActivityCardSummary(_ card: WorkEventCardModel) -> String {
  let pieces = [card.metadata.first, card.body, card.title]
    .compactMap { nonEmptyWorkTimelineText($0) }
  return pieces.first ?? card.title
}

func normalizedWorkLocalEchoText(_ text: String) -> String {
  text
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
}

func workLocalEchoDedupeKey(text: String, attachments: [AgentChatFileRef]?) -> String? {
  let normalized = normalizedWorkLocalEchoText(text)
  guard !normalized.isEmpty else { return nil }
  let attachmentKey = (attachments ?? [])
    .map { "\($0.type)|\($0.path)|\($0.url ?? "")" }
    .joined(separator: "\u{1f}")
  return "\(normalized)\u{1e}\(attachmentKey)"
}

func buildWorkCommandCards(from transcript: [WorkChatEnvelope]) -> [WorkCommandCardModel] {
  var byId: [String: WorkCommandCardModel] = [:]
  var order: [String] = []
  for envelope in transcript {
    guard case .command(let command, let cwd, let output, let status, let itemId, let exitCode, let durationMs, _) = envelope.event else {
      continue
    }
    if byId[itemId] == nil { order.append(itemId) }
    byId[itemId] = WorkCommandCardModel(
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
  return order.compactMap { byId[$0] }
}

func buildWorkFileChangeCards(from transcript: [WorkChatEnvelope]) -> [WorkFileChangeCardModel] {
  var byId: [String: WorkFileChangeCardModel] = [:]
  var order: [String] = []
  for envelope in transcript {
    guard case .fileChange(let path, let diff, let kind, let status, let itemId, _) = envelope.event else {
      continue
    }
    if byId[itemId] == nil { order.append(itemId) }
    byId[itemId] = WorkFileChangeCardModel(
      id: itemId,
      path: path,
      diff: diff,
      kind: kind,
      status: status,
      timestamp: envelope.timestamp
    )
  }
  return order.compactMap { byId[$0] }
}

/// Map each resolved pending-input `itemId` to its resolution word so the
/// question / plan / approval cards can render the outcome inline. When several
/// resolutions share an itemId the last one wins (a re-answer supersedes).
private func workPendingInputResolutions(from transcript: [WorkChatEnvelope]) -> [String: String] {
  var result: [String: String] = [:]
  for envelope in transcript {
    guard case .pendingInputResolved(let itemId, let resolution, _) = envelope.event else { continue }
    let trimmed = resolution.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { continue }
    result[itemId] = trimmed
  }
  return result
}

/// Set of pending-input `itemId`s whose resolution is rendered inline on a
/// question, plan-approval, or generic-approval card. Their standalone "Input
/// resolved" ribbon is folded away in `buildWorkEventCards`. Permission and
/// model-selection gates are excluded — they don't surface the resolution
/// inline, so their ribbon stays.
private func workResolvedInlineItemIds(from transcript: [WorkChatEnvelope]) -> Set<String> {
  var ids = Set<String>()
  for envelope in transcript {
    switch envelope.event {
    case .approvalRequest(let description, let detail, let itemId, _):
      if pendingWorkModelSelectionFromApproval(description: description, detail: detail, itemId: itemId) != nil {
        continue
      }
      if pendingWorkPlanApprovalFromApproval(description: description, detail: detail, itemId: itemId) != nil {
        ids.insert(itemId)
      } else if pendingWorkQuestionFromApproval(description: description, detail: detail, itemId: itemId) != nil {
        ids.insert(itemId)
      } else if pendingWorkPermissionFromApproval(description: description, detail: detail, itemId: itemId) != nil {
        continue
      } else {
        ids.insert(itemId)
      }
    case .structuredQuestion(_, _, let itemId, _):
      ids.insert(itemId)
    default:
      continue
    }
  }
  return ids
}

func buildWorkEventCards(
  from transcript: [WorkChatEnvelope],
  suppressedItemIds: Set<String> = []
) -> [WorkEventCardModel] {
  var byId: [String: WorkEventCardModel] = [:]
  var order: [String] = []
  let terminalDoneTurnIds = workTerminalDoneTurnIds(from: transcript)
  // Join `pending_input_resolved` events onto the question / plan / approval
  // card they resolve so those cards can show the outcome inline. Any resolved
  // itemId that lands on such a card gets its standalone "Input resolved" ribbon
  // folded away (below) to avoid rendering the resolution twice.
  let resolutionByItemId = workPendingInputResolutions(from: transcript)
  let foldedResolutionItemIds = workResolvedInlineItemIds(from: transcript)
  for envelope in transcript {
    if !suppressedItemIds.isEmpty {
      switch envelope.event {
      case .approvalRequest(_, _, let itemId, _) where suppressedItemIds.contains(itemId):
        continue
      case .structuredQuestion(_, _, let itemId, _) where suppressedItemIds.contains(itemId):
        continue
      default:
        break
      }
    }
    if case .pendingInputResolved(let itemId, _, _) = envelope.event,
       foldedResolutionItemIds.contains(itemId) {
      continue
    }
    if redundantWorkTerminalStatus(envelope.event, terminalDoneTurnIds: terminalDoneTurnIds) {
      continue
    }
    guard let card = eventCard(for: envelope, resolutionByItemId: resolutionByItemId) else { continue }
    if let existing = byId[card.id], let merged = mergedWorkEventCard(existing, with: card) {
      byId[card.id] = merged
    } else {
      if byId[card.id] == nil { order.append(card.id) }
      byId[card.id] = card
    }
  }
  return order.compactMap { byId[$0] }
}

private func workTerminalDoneTurnIds(from transcript: [WorkChatEnvelope]) -> Set<String> {
  Set(transcript.compactMap { envelope in
    guard case .done(_, _, _, let turnId, _, _) = envelope.event else { return nil }
    return normalizedWorkTurnId(turnId)
  })
}

private func redundantWorkTerminalStatus(
  _ event: WorkChatEvent,
  terminalDoneTurnIds: Set<String>
) -> Bool {
  guard case .status(let turnStatus, let message, let turnId) = event,
        let key = normalizedWorkTurnId(turnId),
        terminalDoneTurnIds.contains(key)
  else {
    return false
  }
  let normalizedStatus = turnStatus.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  let normalizedMessage = message?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
  return (normalizedMessage.isEmpty || normalizedMessage == normalizedStatus)
    && (normalizedStatus == "interrupted" || normalizedStatus == "failed")
}

private func workReasoningCardId(
  sessionId: String,
  turnId: String?,
  itemId: String?,
  summaryIndex: Int?,
  fallback: String
) -> String {
  if let itemId, !itemId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
    return ["reasoning", sessionId, "item", itemId].joined(separator: ":")
  }
  if let turnId, !turnId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
    if let summaryIndex {
      return ["reasoning", sessionId, "turn", turnId, "summary", String(summaryIndex)].joined(separator: ":")
    }
    return ["reasoning", sessionId, "turn", turnId].joined(separator: ":")
  }
  return fallback
}

/// Stable identity for a context-compaction divider. Both the `started` and
/// `completed` events for one compaction share this id (prefer `compactionId`,
/// then turn) so `buildWorkEventCards` merges them into a single card that flips
/// from the live "Compacting context…" state to "Context compacted" in place.
/// Cross-turn Codex compactions reuse one `compactionId` across turns. Without
/// either key — legacy end-only `context_compact` events — fall back to the
/// envelope id, which preserves the prior one-card-per-event behavior.
private func workContextCompactCardId(
  sessionId: String,
  turnId: String?,
  compactionId: String?,
  fallback: String
) -> String {
  let trimmedCompactionId = compactionId?.trimmingCharacters(in: .whitespacesAndNewlines)
  if let trimmedCompactionId, !trimmedCompactionId.isEmpty {
    return ["context-compact", sessionId, "compaction", trimmedCompactionId].joined(separator: ":")
  }
  if let turnId, !turnId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
    return ["context-compact", sessionId, "turn", turnId].joined(separator: ":")
  }
  return fallback
}

private func workPlanCardId(
  sessionId: String,
  turnId: String?,
  fallback: String
) -> String {
  if let turnId, !turnId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
    return ["plan", sessionId, "turn", turnId].joined(separator: ":")
  }
  return fallback
}

private func workPlanTextCardId(
  sessionId: String,
  turnId: String?,
  fallback: String
) -> String {
  if let turnId, !turnId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
    return ["plan-text", sessionId, "turn", turnId].joined(separator: ":")
  }
  return fallback
}

private func mergeWorkInlineText(_ existing: String, _ incoming: String) -> String {
  if existing.isEmpty { return incoming }
  if incoming.isEmpty { return existing }
  if existing == incoming { return existing }
  if incoming.hasPrefix(existing) { return incoming }
  if existing.hasPrefix(incoming) { return existing }
  if existing.contains(incoming) { return existing }
  if incoming.contains(existing) { return incoming }
  let separator = existing.last?.isWhitespace == false && incoming.first?.isWhitespace == false ? " " : ""
  return "\(existing)\(separator)\(incoming)"
}

private func laterWorkTimestamp(_ lhs: String, _ rhs: String) -> String {
  let lhsDate = workParsedDate(lhs)
  let rhsDate = workParsedDate(rhs)

  if let lhsDate, let rhsDate {
    return rhsDate >= lhsDate ? rhs : lhs
  }
  if rhsDate != nil { return rhs }
  return lhs
}

private func approvalRequestEventCard(
  id: String,
  timestamp: String,
  description: String,
  detail: String?,
  itemId: String,
  resolution: String? = nil
) -> WorkEventCardModel {
  if let planApproval = pendingWorkPlanApprovalFromApproval(description: description, detail: detail, itemId: itemId) {
    // The resolved plan card renders a markdown preview + expand-to-sheet from
    // `planApprovalModel`, so we no longer split the plan into per-line bullets.
    return WorkEventCardModel(
      id: id,
      kind: "planApproval",
      title: "Plan approval requested",
      icon: "list.clipboard",
      tint: .warning,
      timestamp: timestamp,
      body: nonEmptyWorkTimelineText(planApproval.title) ?? nonEmptyWorkTimelineText(description),
      bullets: [],
      metadata: nonEmptyWorkTimelineText(planApproval.source).map { [$0] } ?? [],
      planApprovalModel: planApproval,
      resolution: resolution
    )
  }

  if let question = pendingWorkQuestionFromApproval(description: description, detail: detail, itemId: itemId) {
    // The resolved question card renders provider logo + question text + option
    // rows from `questionModel`, so title/body/bullets are only fallbacks for
    // the (now-unused) generic path and accessibility text.
    return WorkEventCardModel(
      id: id,
      kind: "question",
      title: "Question asked",
      icon: "questionmark.circle",
      tint: .warning,
      timestamp: timestamp,
      body: nonEmptyWorkTimelineText(question.body),
      bullets: [],
      metadata: [],
      questionModel: question,
      resolution: resolution
    )
  }

  if let permission = pendingWorkPermissionFromApproval(description: description, detail: detail, itemId: itemId) {
    return WorkEventCardModel(
      id: id,
      kind: "permission",
      title: "Permission requested",
      icon: "hand.raised.fill",
      tint: .warning,
      timestamp: timestamp,
      body: workApprovalRequestBody(primary: permission.description, secondary: permission.detail, fallback: description),
      bullets: [],
      metadata: [permission.tool].compactMap(nonEmptyWorkTimelineText)
    )
  }

  // Resolved generic / file-change approvals collapse to a compact chip
  // (`WorkResolvedApprovalChip`) showing the description once + the outcome, so
  // we drop the redundant detail bullets/metadata that used to print the
  // description three times (title, body, and a bullet).
  return WorkEventCardModel(
    id: id,
    kind: "approval",
    title: "Approval needed",
    icon: "checkmark.shield",
    tint: .warning,
    timestamp: timestamp,
    body: nonEmptyWorkTimelineText(description),
    bullets: [],
    metadata: [],
    resolution: resolution
  )
}

private func workApprovalRequestBody(primary: String?, secondary: String?, fallback: String) -> String? {
  var pieces: [String] = []
  for candidate in [primary, secondary, fallback] {
    guard let text = nonEmptyWorkTimelineText(candidate) else { continue }
    let alreadyIncluded = pieces.contains { existing in
      existing.caseInsensitiveCompare(text) == .orderedSame
    }
    if !alreadyIncluded {
      pieces.append(text)
    }
  }
  guard !pieces.isEmpty else { return nil }
  return pieces.prefix(2).joined(separator: "\n")
}

private func nonEmptyWorkTimelineText(_ value: String?) -> String? {
  guard let value else { return nil }
  let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
  return trimmed.isEmpty ? nil : trimmed
}

private func strippedWorkActivityStatusPrefix(_ value: String) -> String {
  let prefixes = ["In Progress: ", "Completed: ", "Pending: "]
  for prefix in prefixes where value.hasPrefix(prefix) {
    return String(value.dropFirst(prefix.count))
  }
  return value
}

private func truncatedWorkTimelineText(_ value: String, limit: Int) -> String {
  guard value.count > limit, limit > 3 else { return value }
  return "\(value.prefix(limit - 3))..."
}

private func mergedWorkEventCard(_ existing: WorkEventCardModel, with incoming: WorkEventCardModel) -> WorkEventCardModel? {
  guard existing.kind == incoming.kind else { return nil }
  if existing.kind == "reasoning" {
    return WorkEventCardModel(
      id: incoming.id,
      kind: incoming.kind,
      title: incoming.title,
      icon: incoming.icon,
      tint: incoming.tint,
      timestamp: laterWorkTimestamp(existing.timestamp, incoming.timestamp),
      body: mergeWorkInlineText(existing.body ?? "", incoming.body ?? ""),
      bullets: incoming.bullets.isEmpty ? existing.bullets : incoming.bullets,
      metadata: incoming.metadata.isEmpty ? existing.metadata : incoming.metadata,
      planSteps: incoming.planSteps.isEmpty ? existing.planSteps : incoming.planSteps
    )
  }
  if existing.kind == "plan" {
    return WorkEventCardModel(
      id: incoming.id,
      kind: incoming.kind,
      title: incoming.title,
      icon: incoming.icon,
      tint: incoming.tint,
      timestamp: laterWorkTimestamp(existing.timestamp, incoming.timestamp),
      body: nonEmptyWorkTimelineText(incoming.body) ?? existing.body,
      bullets: incoming.bullets.isEmpty ? existing.bullets : incoming.bullets,
      metadata: incoming.metadata.isEmpty ? existing.metadata : incoming.metadata,
      planSteps: incoming.planSteps.isEmpty ? existing.planSteps : incoming.planSteps
    )
  }
  if existing.kind == "planText" {
    return WorkEventCardModel(
      id: incoming.id,
      kind: incoming.kind,
      title: incoming.title,
      icon: incoming.icon,
      tint: incoming.tint,
      timestamp: laterWorkTimestamp(existing.timestamp, incoming.timestamp),
      body: mergeWorkInlineText(existing.body ?? "", incoming.body ?? ""),
      bullets: incoming.bullets.isEmpty ? existing.bullets : incoming.bullets,
      metadata: incoming.metadata.isEmpty ? existing.metadata : incoming.metadata,
      planSteps: incoming.planSteps.isEmpty ? existing.planSteps : incoming.planSteps
    )
  }
  return incoming
}

private func eventCard(
  for envelope: WorkChatEnvelope,
  resolutionByItemId: [String: String] = [:]
) -> WorkEventCardModel? {
  switch envelope.event {
    case .activity:
      // Activity events ("searching_glob", "running_bash", etc.) are pre-tool
      // announcements. The corresponding tool card already represents the
      // work, so persisting them as separate timeline entries just stacks
      // redundant rows under each tool group. Live streaming hints come from
      // WorkActivityIndicator, not the persisted timeline.
      return nil
    case .plan(let steps, let explanation, let turnId):
      guard !steps.isEmpty || nonEmptyWorkTimelineText(explanation) != nil else {
        return nil
      }
      return WorkEventCardModel(
        id: workPlanCardId(sessionId: envelope.sessionId, turnId: turnId, fallback: envelope.id),
        kind: "plan",
        title: "Plan",
        icon: "list.bullet.clipboard",
        tint: .accent,
        timestamp: envelope.timestamp,
        body: nonEmptyWorkTimelineText(explanation),
        bullets: steps.map { $0.text },
        metadata: [],
        planSteps: steps
      )
    case .reasoning(let text, let turnId, let itemId, let summaryIndex):
      guard !isLowSignalWorkReasoning(text) else { return nil }
      return WorkEventCardModel(
        id: workReasoningCardId(sessionId: envelope.sessionId, turnId: turnId, itemId: itemId, summaryIndex: summaryIndex, fallback: envelope.id),
        kind: "reasoning",
        title: "Reasoning",
        icon: "brain.head.profile",
        tint: .secondary,
        timestamp: envelope.timestamp,
        body: text,
        bullets: [],
        metadata: []
      )
    case .approvalRequest(let description, let detail, let itemId, _):
      return approvalRequestEventCard(
        id: envelope.id,
        timestamp: envelope.timestamp,
        description: description,
        detail: detail,
        itemId: itemId,
        resolution: resolutionByItemId[itemId]
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
    case .structuredQuestion(let question, let options, let itemId, _):
      let questionModel = WorkPendingQuestionModel(
        id: itemId,
        questions: [
          WorkPendingQuestion(
            questionId: "response",
            question: question,
            options: options,
            allowsFreeform: options.isEmpty
          )
        ]
      )
      return WorkEventCardModel(
        id: envelope.id,
        kind: "question",
        title: "Question",
        icon: "questionmark.circle",
        tint: .warning,
        timestamp: envelope.timestamp,
        body: question,
        bullets: options.map { $0.label },
        metadata: [],
        questionModel: questionModel,
        resolution: resolutionByItemId[itemId]
      )
    case .todoUpdate(let items, let turnId):
      let completed = items.filter { $0.lowercased().hasPrefix("completed:") }.count
      let active = items.first { $0.lowercased().hasPrefix("in progress:") }
        ?? items.first { !$0.lowercased().hasPrefix("completed:") }
        ?? items.last
      let progressLabel = items.isEmpty ? "updated" : "\(completed)/\(items.count) complete"
      return WorkEventCardModel(
        id: workActivityCardId(sessionId: envelope.sessionId, turnId: turnId, fallback: envelope.id),
        kind: "todo",
        title: "Task update",
        icon: "checklist",
        tint: .accent,
        timestamp: envelope.timestamp,
        body: active.map { strippedWorkActivityStatusPrefix($0) },
        bullets: items,
        metadata: ["Tasks · \(progressLabel)"]
      )
    case .subagentStarted, .subagentProgress, .subagentResult:
      // Subagent lifecycle is represented by WorkSubagentStrip, the composer
      // badge, and the Subagents drawer. Rendering every lifecycle envelope as
      // a normal event card makes mobile chats look much longer than desktop.
      return nil
    case .scheduledWorkUpdate(_, let kind, let status, _, let title, let summary, let prompt, let reason, let cron, let nextRunAt, _, _, _, _, _, let turnId, let error):
      // Background shell commands are owned by the Chat Info pane's Background
      // section (and a compact timeline finish chip). Mirrors desktop, which
      // stops rendering an inline scheduled-work card for background_task.
      guard kind.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() != "background_task" else {
        return nil
      }
      let normalized = status.replacingOccurrences(of: "_", with: " ").capitalized
      return WorkEventCardModel(
        id: workActivityCardId(sessionId: envelope.sessionId, turnId: turnId, fallback: envelope.id),
        kind: "activity",
        title: kind == "cron" ? "Cron \(normalized.lowercased())" : "Scheduled work \(normalized.lowercased())",
        icon: kind == "cron" ? "calendar.badge.clock" : "clock.arrow.circlepath",
        tint: status == "failed" || status == "cancelled" ? .danger
          : status == "running" || status == "fired" ? .accent
          // Paused/stopped schedules read as inactive, not pending (amber).
          : status == "paused" || status == "stopped" ? .secondary
          : .warning,
        timestamp: envelope.timestamp,
        body: nonEmptyWorkTimelineText(summary)
          ?? nonEmptyWorkTimelineText(error)
          ?? nonEmptyWorkTimelineText(title)
          ?? nonEmptyWorkTimelineText(reason)
          ?? nonEmptyWorkTimelineText(prompt)
          ?? nonEmptyWorkTimelineText(cron)
          ?? nonEmptyWorkTimelineText(nextRunAt),
        bullets: [],
        metadata: [kind == "cron" ? "Cron \(normalized.lowercased())" : "Schedule \(normalized.lowercased())"]
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
    case .contextCompact(let summary, let isInProgress, let turnId, let compactionId):
      return WorkEventCardModel(
        // Prefer compactionId so started/completed pairs merge even when Codex
        // finishes on a different turn. Falls back to turnId, then envelope id.
        id: workContextCompactCardId(
          sessionId: envelope.sessionId,
          turnId: turnId,
          compactionId: compactionId,
          fallback: envelope.id
        ),
        kind: "contextCompact",
        title: isInProgress ? "Compacting context…" : "Context compacted",
        icon: "rectangle.compress.vertical",
        tint: .secondary,
        timestamp: envelope.timestamp,
        body: summary,
        bullets: [],
        metadata: [],
        isInProgress: isInProgress
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
    case .webSearch:
      return nil
    case .codexState(let title, let message, let icon, _):
      return WorkEventCardModel(
        id: envelope.id,
        kind: "codexState",
        title: title,
        icon: icon,
        tint: .secondary,
        timestamp: envelope.timestamp,
        body: message,
        bullets: [],
        metadata: []
      )
    case .codexTurnStalled(let message, let recoveryOptions, let turnId, let sourceSessionId):
      return WorkEventCardModel(
        id: envelope.id,
        kind: "codexRecovery",
        title: "Recovery",
        icon: "exclamationmark.triangle",
        tint: .warning,
        timestamp: envelope.timestamp,
        body: message,
        bullets: [],
        metadata: [],
        recoveryOptions: recoveryOptions,
        recoveryTurnId: turnId,
        recoverySessionId: sourceSessionId
      )
    case .planText(let text, let turnId):
      return WorkEventCardModel(
        id: workPlanTextCardId(sessionId: envelope.sessionId, turnId: turnId, fallback: envelope.id),
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

func isLowSignalWorkReasoning(_ text: String) -> Bool {
  let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  return normalized.isEmpty || normalized == "thinking through the answer"
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

let workTimelinePageSize = 36

func visibleWorkTimelineEntries(from entries: [WorkTimelineEntry], visibleCount: Int) -> [WorkTimelineEntry] {
  let clampedCount = max(visibleCount, 0)
  guard clampedCount < entries.count else { return entries }
  let suffixStart = entries.count - clampedCount
  let visibleSuffix = Array(entries.suffix(clampedCount))
  let hiddenPendingInputs = entries.prefix(suffixStart).filter(\.isPendingInput)
  return hiddenPendingInputs + visibleSuffix
}

private extension WorkTimelineEntry {
  var isPendingInput: Bool {
    switch payload {
    case .pendingQuestion, .pendingPermission, .pendingPlanApproval, .pendingModelSelection:
      return true
    default:
      return false
    }
  }
}

/// Walk a sorted timeline and emit a turn-separator pill before each user
/// message so the transcript reads like the desktop AgentChatPane: a centered
/// "HH:MM AM · Model" label introduces every new turn.
///
/// The separator carries the user-message timestamp and the model recorded for
/// that turn when the host emitted a terminal `done` event. Falling back to the
/// chat's current model keeps in-progress turns labeled while avoiding relabels
/// of older turns after a model switch.
func injectWorkTurnSeparators(
  into entries: [WorkTimelineEntry],
  chatSummary: AgentChatSessionSummary?,
  transcript: [WorkChatEnvelope] = []
) -> [WorkTimelineEntry] {
  injectWorkTurnSeparators(
    into: entries,
    provider: chatSummary?.provider ?? "",
    model: chatSummary?.model ?? "",
    modelId: chatSummary?.modelId,
    transcript: transcript
  )
}

func injectWorkTurnSeparators(
  into entries: [WorkTimelineEntry],
  provider: String,
  model: String,
  modelId: String?,
  transcript: [WorkChatEnvelope] = []
) -> [WorkTimelineEntry] {
  guard !entries.isEmpty else { return entries }
  var seenTurnIds = Set<String>()
  var output: [WorkTimelineEntry] = []
  output.reserveCapacity(entries.count + 4)

  let fallbackModelId = modelId ?? model
  let fallbackMetadata = WorkTurnModelMetadata(
    provider: provider,
    modelLabel: prettyWorkChatModelName(model),
    modelId: fallbackModelId
  )
  let visibleTurnIds = Set(entries.compactMap { entry -> String? in
    guard case .message(let message) = entry.payload,
          message.role.lowercased() == "user"
    else { return nil }
    return normalizedWorkTurnId(message.turnId)
  })
  let metadataByTurn = workTurnModelMetadataByTurn(
    from: transcript,
    fallback: fallbackMetadata,
    matchingTurnIds: visibleTurnIds
  )

  for entry in entries {
    if case .message(let message) = entry.payload, message.role.lowercased() == "user" {
      // De-dupe by turnId when present; otherwise allow one separator per
      // user message (which is how desktop chunks the transcript).
      let key = message.turnId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "msg-\(message.id)"
      if !seenTurnIds.contains(key) {
        seenTurnIds.insert(key)
        let metadata = message.turnId
          .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
          .flatMap { metadataByTurn[$0] }
          ?? fallbackMetadata
        let separator = WorkTurnSeparator(
          time: message.timestamp,
          provider: metadata.provider,
          modelLabel: metadata.modelLabel,
          modelId: metadata.modelId
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

func workTurnEndMarkers(from transcript: [WorkChatEnvelope]) -> [WorkTurnEndMarker] {
  var startByTurn: [String: String] = [:]
  var markers: [WorkTurnEndMarker] = []
  var seenEndedTurns = Set<String>()

  for envelope in sortedWorkChatEnvelopes(transcript) {
    switch envelope.event {
    case .userMessage(_, _, let turnId, _, _, _):
      guard let key = normalizedWorkTurnId(turnId), startByTurn[key] == nil else { continue }
      startByTurn[key] = envelope.timestamp
    case .status(let turnStatus, _, let turnId):
      switch turnStatus.lowercased() {
      case "started", "active", "running", "inprogress", "in_progress", "in-progress":
        guard let key = normalizedWorkTurnId(turnId), startByTurn[key] == nil else { continue }
        startByTurn[key] = envelope.timestamp
      default:
        continue
      }
    case .done(let status, _, _, let turnId, let model, let modelId):
      guard let key = normalizedWorkTurnId(turnId) else { continue }
      guard !seenEndedTurns.contains(key), let start = startByTurn[key] else { continue }
      seenEndedTurns.insert(key)
      let metadata = workTurnModelMetadata(model: model, modelId: modelId, fallbackProvider: "")
      markers.append(WorkTurnEndMarker(
        turnId: key,
        time: envelope.timestamp,
        workedDurationLabel: formattedSessionDuration(startedAt: start, endedAt: envelope.timestamp),
        status: status,
        provider: metadata.provider,
        modelLabel: metadata.modelLabel,
        modelId: metadata.modelId
      ))
    default:
      guard let key = normalizedWorkTurnId(workTurnId(for: envelope.event)), startByTurn[key] == nil else { continue }
      startByTurn[key] = envelope.timestamp
    }
  }

  return markers
}

private func normalizedWorkTurnId(_ turnId: String?) -> String? {
  let key = turnId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  return key.isEmpty ? nil : key
}

private func workTurnId(for event: WorkChatEvent) -> String? {
  switch event {
  case .userMessage(_, _, let turnId, _, _, _),
       .assistantText(_, let turnId, _),
       .toolCall(_, _, _, _, let turnId),
       .toolResult(_, _, _, _, let turnId, _),
       .activity(_, _, let turnId),
       .plan(_, _, let turnId),
       .subagentStarted(_, _, _, _, _, _, _, _, _, let turnId),
       .subagentProgress(_, _, _, _, _, _, _, _, _, _, let turnId),
       .subagentResult(_, _, _, _, _, _, _, _, _, let turnId),
       .scheduledWorkUpdate(_, _, _, _, _, _, _, _, _, _, _, _, _, _, _, let turnId, _),
       .transcriptRetraction(_, _, _, let turnId),
       .structuredQuestion(_, _, _, let turnId),
       .approvalRequest(_, _, _, let turnId),
       .pendingInputResolved(_, _, let turnId),
       .todoUpdate(_, let turnId),
       .systemNotice(_, _, _, let turnId, _),
       .error(_, _, _, let turnId),
       .promptSuggestion(_, let turnId),
       .contextCompact(_, _, let turnId, _),
       .autoApprovalReview(_, let turnId),
       .webSearch(_, _, _, _, _, let turnId),
       .codexState(_, _, _, let turnId),
       .codexTurnStalled(_, _, let turnId, _),
       .planText(_, let turnId),
       .toolUseSummary(_, let turnId),
       .status(_, _, let turnId),
       .reasoning(_, let turnId, _, _),
       .completionReport(_, _, _, _, let turnId),
       .command(_, _, _, _, _, _, _, let turnId),
       .fileChange(_, _, _, _, _, let turnId):
    return turnId
  case .tokens(_, let turnId, _):
    return turnId
  case .done(_, _, _, let turnId, _, _):
    return turnId
  case .unknown:
    return nil
  }
}

struct WorkTurnModelMetadata {
  let provider: String
  let modelLabel: String
  let modelId: String?
}

func workTurnModelMetadataByTurn(
  from transcript: [WorkChatEnvelope],
  fallback: WorkTurnModelMetadata? = nil,
  matchingTurnIds: Set<String>? = nil
) -> [String: WorkTurnModelMetadata] {
  var metadataByTurn: [String: WorkTurnModelMetadata] = [:]
  if let matchingTurnIds {
    guard !matchingTurnIds.isEmpty else { return metadataByTurn }
    for envelope in transcript.reversed() {
      guard case .done(_, _, _, let turnId, let model, let modelId) = envelope.event else { continue }
      let normalizedTurnId = turnId.trimmingCharacters(in: .whitespacesAndNewlines)
      guard matchingTurnIds.contains(normalizedTurnId),
            metadataByTurn[normalizedTurnId] == nil else { continue }
      metadataByTurn[normalizedTurnId] = workTurnModelMetadata(
        model: model,
        modelId: modelId,
        fallbackProvider: fallback?.provider ?? "",
        fallbackModelLabel: fallback?.modelLabel ?? "Model",
        fallbackModelId: fallback?.modelId
      )
      if metadataByTurn.count == matchingTurnIds.count { break }
    }
    return metadataByTurn
  }

  for envelope in transcript {
    guard case .done(_, _, _, let turnId, let model, let modelId) = envelope.event else { continue }
    let normalizedTurnId = turnId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedTurnId.isEmpty else { continue }
    metadataByTurn[normalizedTurnId] = workTurnModelMetadata(
      model: model,
      modelId: modelId,
      fallbackProvider: fallback?.provider ?? "",
      fallbackModelLabel: fallback?.modelLabel ?? "Model",
      fallbackModelId: fallback?.modelId
    )
  }
  return metadataByTurn
}

private func workTurnModelMetadata(
  model: String?,
  modelId: String?,
  fallbackProvider: String,
  fallbackModelLabel: String = "Model",
  fallbackModelId: String? = nil
) -> WorkTurnModelMetadata {
  let rawModel = [model, modelId]
    .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
    .first { !$0.isEmpty }
    ?? ""
  let rawModelId = [modelId, model]
    .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
    .first { !$0.isEmpty }
  return WorkTurnModelMetadata(
    provider: workModelCatalogGroupKey(for: rawModelId ?? rawModel, currentProvider: fallbackProvider),
    modelLabel: rawModel.isEmpty ? fallbackModelLabel : prettyWorkChatModelName(rawModel),
    modelId: rawModelId ?? fallbackModelId
  )
}

/// Beautify a host-supplied model id into the label used on chips and turn
/// separators. Mirrors the desktop composer's display: "Claude Sonnet 5",
/// "GPT-5.4", etc., so iOS and desktop read the same.
func prettyWorkChatModelName(_ raw: String) -> String {
  let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return "Model" }
  if let known = workKnownModelDisplayName(trimmed) {
    return known
  }
  switch trimmed.lowercased() {
  case let lower where lower.hasPrefix("claude-"):
    return "Claude " + beautifyWorkModelSegment(String(trimmed.dropFirst("claude-".count)))
  default:
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
  reasoningTokens: Int? = nil,
  totalTokens: Int? = nil,
  contextWindow: Int? = nil,
  costUsd: Double?
) -> WorkUsageSummary? {
  guard inputTokens != nil
    || outputTokens != nil
    || cacheReadTokens != nil
    || cacheCreationTokens != nil
    || reasoningTokens != nil
    || totalTokens != nil
    || contextWindow != nil
    || costUsd != nil
  else {
    return nil
  }

  return WorkUsageSummary(
    turnCount: 1,
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheCreationTokens: cacheCreationTokens ?? 0,
    reasoningTokens: reasoningTokens ?? 0,
    totalTokens: totalTokens ?? 0,
    contextWindow: contextWindow,
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
    reasoningTokens: 0,
    totalTokens: 0,
    costUsd: 0
  )

  for envelope in transcript {
    guard case .done(_, _, let usage, _, _, _) = envelope.event, let usage else { continue }
    summary.turnCount += usage.turnCount
    summary.inputTokens += usage.inputTokens
    summary.outputTokens += usage.outputTokens
    summary.cacheReadTokens += usage.cacheReadTokens
    summary.cacheCreationTokens += usage.cacheCreationTokens
    summary.reasoningTokens += usage.reasoningTokens
    summary.totalTokens += usage.totalTokens
    summary.contextWindow = usage.contextWindow ?? summary.contextWindow
    summary.costUsd += usage.costUsd
  }

  return summary.turnCount > 0 ? summary : nil
}

func workContextUsageViewModel(
  transcript: [WorkChatEnvelope],
  summary: AgentChatSessionSummary?
) -> WorkContextUsageViewModel? {
  let provider = summary?.provider ?? ""
  let fallbackWindow = workContextWindowFallback(summary: summary)
  return workContextUsageViewModel(
    transcript: transcript,
    provider: provider,
    fallbackContextWindow: fallbackWindow
  )
}

func workContextUsageViewModel(
  transcript: [WorkChatEnvelope],
  provider: String,
  fallbackContextWindow: Int?
) -> WorkContextUsageViewModel? {

  for envelope in sortedWorkChatEnvelopes(transcript).reversed() {
    switch envelope.event {
    case .tokens(let usage, _, _):
      return makeWorkContextUsageViewModel(
        usage: usage,
        provider: provider,
        fallbackContextWindow: fallbackContextWindow
      )
    case .done(_, _, let usage, _, _, _):
      if let usage {
        return makeWorkContextUsageViewModel(
          usage: usage,
          provider: provider,
          fallbackContextWindow: fallbackContextWindow
        )
      }
    default:
      continue
    }
  }

  return nil
}

private func makeWorkContextUsageViewModel(
  usage: WorkUsageSummary,
  provider: String,
  fallbackContextWindow: Int?
) -> WorkContextUsageViewModel? {
  let inputTokens = positiveWorkTokenCount(usage.inputTokens)
  let outputTokens = positiveWorkTokenCount(usage.outputTokens)
  let cacheReadTokens = positiveWorkTokenCount(usage.cacheReadTokens)
  let cacheWriteTokens = positiveWorkTokenCount(usage.cacheCreationTokens)
  let reasoningTokens = positiveWorkTokenCount(usage.reasoningTokens)
  let totalTokens = positiveWorkTokenCount(usage.totalTokens)
  let runtimeWindow = positiveWorkTokenCount(usage.contextWindow)
  let contextWindow = runtimeWindow ?? positiveWorkTokenCount(fallbackContextWindow)
  let usedTokens: Int? = {
    if workProviderUsesCodexTokenOccupancy(provider) {
      return inputTokens ?? positiveWorkTokenCount(usage.inputTokens + usage.outputTokens) ?? totalTokens
    }
    let occupancy = (inputTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
    return occupancy > 0 ? occupancy : positiveWorkTokenCount(usage.inputTokens + usage.outputTokens) ?? totalTokens
  }()

  guard usedTokens != nil || inputTokens != nil || outputTokens != nil || totalTokens != nil else { return nil }

  let ratio = contextWindow.flatMap { window -> Double? in
    guard let usedTokens, window > 0 else { return nil }
    return min(1, max(0, Double(usedTokens) / Double(window)))
  }

  return WorkContextUsageViewModel(
    provider: provider,
    contextWindow: contextWindow,
    usedTokens: usedTokens,
    inputTokens: inputTokens,
    outputTokens: outputTokens,
    cacheReadTokens: cacheReadTokens,
    cacheWriteTokens: cacheWriteTokens,
    reasoningTokens: reasoningTokens,
    totalTokens: totalTokens ?? positiveWorkTokenCount(usage.inputTokens + usage.outputTokens),
    ratio: ratio,
    windowSource: runtimeWindow != nil ? .runtime : (contextWindow != nil ? .registry : nil)
  )
}

private func positiveWorkTokenCount(_ value: Int?) -> Int? {
  guard let value, value > 0 else { return nil }
  return value
}

private func workProviderUsesCodexTokenOccupancy(_ provider: String) -> Bool {
  let normalized = provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  return normalized == "codex" || normalized == "openai"
}

func workContextWindowFallback(summary: AgentChatSessionSummary?) -> Int? {
  guard let summary else { return nil }
  return workContextWindowFallback(modelId: summary.modelId, model: summary.model)
}

func workContextWindowFallback(modelId: String?, model: String) -> Int? {
  let modelKey = [modelId, Optional(model)]
    .compactMap { $0?.lowercased() }
    .joined(separator: " ")

  if modelKey.contains("1m") || modelKey.contains("1-million") { return 1_000_000 }
  if modelKey.contains("gpt-5") {
    return 258_400
  }
  if modelKey.contains("claude") || modelKey.contains("sonnet") || modelKey.contains("opus") || modelKey.contains("haiku") || modelKey.contains("fable") {
    return 200_000
  }
  if modelKey.contains("gpt-4.1") || modelKey.contains("gpt-4o") {
    return 128_000
  }
  return nil
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
