import SwiftUI
import UIKit
import AVKit

func workStableTimelineItemId(itemId: String, logicalItemId: String?) -> String {
  let logical = logicalItemId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  return logical.isEmpty ? itemId : logical
}

/// Optional-itemId overload for transcript parsing, where the raw event dict
/// may omit `itemId`. Keeps the resolution policy in one place so desktop and
/// transcript code paths stay in sync.
func workStableTimelineItemId(itemId: String?, logicalItemId: String?) -> String? {
  let logical = logicalItemId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  if !logical.isEmpty { return logical }
  return itemId
}

private func workNonEmptyImageField(_ value: String?) -> String? {
  let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  return trimmed.isEmpty ? nil : trimmed
}

private func workCompactImageResult(_ value: String?) -> String? {
  guard let value = workNonEmptyImageField(value) else { return nil }
  if value.lowercased().hasPrefix("data:") {
    return "Generated image data"
  }
  return value
}

private func workCompactImageReference(_ value: String?) -> String? {
  guard let value = workNonEmptyImageField(value) else { return nil }
  return value.lowercased().hasPrefix("data:") ? "Inline image data" : value
}

private func workOmittedImageDetail(originalBytes: Int?, omittedBytes: Int?) -> String? {
  guard let omittedBytes, omittedBytes > 0 else { return nil }
  let bytes = max(originalBytes ?? omittedBytes, omittedBytes)
  let count: String
  if bytes >= 1024 * 1024 {
    count = String(format: "%.1f MB", Double(bytes) / Double(1024 * 1024))
  } else if bytes >= 1024 {
    count = "\((bytes + 512) / 1024) KB"
  } else {
    count = "\(bytes) bytes"
  }
  return "Inline preview omitted from mobile sync (\(count))"
}

func workCodexImageGenerationEvent(
  itemId: String,
  turnId: String?,
  prompt: String?,
  revisedPrompt: String?,
  result: String?,
  savedPath: String?,
  resultOriginalBytes: Int? = nil,
  resultOmittedBytes: Int? = nil,
  status rawStatus: String
) -> WorkChatEvent {
  let status = toolStatus(from: rawStatus)
  let effectivePrompt = workNonEmptyImageField(revisedPrompt) ?? workNonEmptyImageField(prompt)
  if status == .running {
    return .toolCall(
      tool: "image_generation",
      argsText: effectivePrompt ?? "Generating image",
      itemId: itemId,
      parentItemId: nil,
      turnId: turnId
    )
  }

  var lines: [String] = []
  if let savedPath = workNonEmptyImageField(savedPath) {
    lines.append(savedPath)
  }
  if let result = workCompactImageResult(result), !lines.contains(result) {
    lines.append(result)
  }
  if let omittedDetail = workOmittedImageDetail(
    originalBytes: resultOriginalBytes,
    omittedBytes: resultOmittedBytes
  ) {
    lines.append(omittedDetail)
  }
  if let effectivePrompt {
    lines.append("Prompt: \(effectivePrompt)")
  }
  if lines.isEmpty {
    lines.append(status == .failed ? "Image generation failed" : "Image generated")
  }
  return .toolResult(
    tool: "image_generation",
    resultText: lines.joined(separator: "\n"),
    itemId: itemId,
    parentItemId: nil,
    turnId: turnId,
    status: status
  )
}

func workCodexImageViewEvent(
  itemId: String,
  turnId: String?,
  path: String?,
  url: String?,
  title: String?,
  urlOriginalBytes: Int? = nil,
  urlOmittedBytes: Int? = nil,
  status rawStatus: String
) -> WorkChatEvent {
  let status = toolStatus(from: rawStatus)
  var fields = [
    workNonEmptyImageField(title),
    workCompactImageReference(path),
    workCompactImageReference(url),
  ].compactMap { $0 }
  if let omittedDetail = workOmittedImageDetail(
    originalBytes: urlOriginalBytes,
    omittedBytes: urlOmittedBytes
  ) {
    fields.append(omittedDetail)
  }
  let detail = fields.isEmpty ? "Image" : fields.joined(separator: "\n")
  if status == .running {
    return .toolCall(
      tool: "image_view",
      argsText: detail,
      itemId: itemId,
      parentItemId: nil,
      turnId: turnId
    )
  }
  return .toolResult(
    tool: "image_view",
    resultText: detail,
    itemId: itemId,
    parentItemId: nil,
    turnId: turnId,
    status: status
  )
}

private final class WorkANSIAttributedStringCacheBox: NSObject {
  let value: AttributedString

  init(_ value: AttributedString) {
    self.value = value
  }
}

private let workANSIAttributedStringCache: NSCache<NSString, WorkANSIAttributedStringCacheBox> = {
  let cache = NSCache<NSString, WorkANSIAttributedStringCacheBox>()
  cache.countLimit = 128
  return cache
}()


func makeWorkChatEvent(from event: AgentChatEvent) -> WorkChatEvent {
  switch event {
  case .userMessage(let text, let attachments, let turnId, let steerId, let deliveryState, let processed):
    return .userMessage(
      text: text,
      attachments: attachments,
      turnId: turnId,
      steerId: steerId,
      deliveryState: deliveryState,
      processed: processed
    )
  case .text(let text, let messageId, let turnId, let itemId):
    let normalizedMessageId = messageId?.trimmingCharacters(in: .whitespacesAndNewlines)
    let normalizedItemId = itemId?.trimmingCharacters(in: .whitespacesAndNewlines)
    let stableItemId = normalizedItemId?.isEmpty == false
      ? normalizedItemId
      : (normalizedMessageId?.isEmpty == false ? normalizedMessageId : nil)
    return .assistantText(text: text, turnId: turnId, itemId: stableItemId)
  case .toolCall(let tool, let args, let itemId, let logicalItemId, let parentItemId, let turnId):
    return .toolCall(
      tool: tool,
      argsText: prettyPrintedRemoteJSONValue(args),
      itemId: workStableTimelineItemId(itemId: itemId, logicalItemId: logicalItemId),
      parentItemId: parentItemId,
      turnId: turnId
    )
  case .toolResult(let tool, let result, let itemId, let logicalItemId, let parentItemId, let turnId, let status):
    return .toolResult(
      tool: tool,
      resultText: prettyPrintedRemoteJSONValue(result),
      itemId: workStableTimelineItemId(itemId: itemId, logicalItemId: logicalItemId),
      parentItemId: parentItemId,
      turnId: turnId,
      status: toolStatus(from: status ?? "running")
    )
  case .activity(let activity, let detail, let turnId):
    return .activity(kind: activity.rawValue, detail: detail, turnId: turnId)
  // Labeled bindings on purpose: AgentChatEvent.plan orders (steps, turnId,
  // explanation) while WorkChatEvent.plan orders (steps, explanation, turnId).
  // A positional match here silently swaps turnId/explanation — the turn id
  // renders as the plan body and per-delta cards stop merging.
  case .plan(steps: let steps, turnId: let turnId, explanation: let explanation):
    let mapped = steps.map { WorkPlanStep(text: $0.text, status: $0.status) }
    return .plan(steps: mapped, explanation: explanation, turnId: turnId)
  case .subagentStarted(let taskId, let agentId, let agentType, let parentAgentId, let parentToolUseId, let description, let background, let label, let model, let reasoningEffort, let turnId):
    return .subagentStarted(
      taskId: taskId,
      agentId: agentId,
      agentType: agentType,
      parentToolUseId: parentToolUseId ?? parentAgentId,
      description: description,
      background: background ?? false,
      label: label,
      model: model,
      reasoningEffort: reasoningEffort,
      turnId: turnId
    )
  case .subagentProgress(let taskId, let agentId, let agentType, let parentAgentId, let parentToolUseId, let description, let summary, _, let lastToolName, let label, let model, let reasoningEffort, let turnId):
    return .subagentProgress(
      taskId: taskId,
      agentId: agentId,
      agentType: agentType,
      parentToolUseId: parentToolUseId ?? parentAgentId,
      description: description,
      summary: summary,
      toolName: lastToolName,
      label: label,
      model: model,
      reasoningEffort: reasoningEffort,
      turnId: turnId
    )
  case .subagentResult(let taskId, let agentId, let agentType, let parentAgentId, let parentToolUseId, let status, let summary, _, let label, let model, let reasoningEffort, let turnId):
    return .subagentResult(
      taskId: taskId,
      agentId: agentId,
      agentType: agentType,
      parentToolUseId: parentToolUseId ?? parentAgentId,
      status: status.rawValue,
      summary: summary,
      label: label,
      model: model,
      reasoningEffort: reasoningEffort,
      turnId: turnId
    )
  case .scheduledWorkUpdate(let id, let kind, let status, let origin, let title, let summary, let prompt, let reason, let cron, let nextRunAt, let lastRunAt, let firedAt, let late, let recurring, let durable, let sourceToolUseId, let sourceTaskId, let turnId, let error):
    return .scheduledWorkUpdate(
      id: id,
      kind: kind,
      status: status,
      origin: origin,
      title: title,
      summary: summary,
      prompt: prompt,
      reason: reason,
      cron: cron,
      nextRunAt: nextRunAt,
      lastRunAt: lastRunAt,
      firedAt: firedAt,
      late: late,
      recurring: recurring,
      durable: durable,
      sourceToolUseId: sourceToolUseId,
      sourceTaskId: sourceTaskId,
      turnId: turnId,
      error: error
    )
  case .transcriptRetraction(let messageIds, let reason, let replacementMessageId, let turnId):
    return .transcriptRetraction(
      messageIds: messageIds,
      reason: reason,
      replacementMessageId: replacementMessageId,
      turnId: turnId
    )
  case .structuredQuestion(let question, let options, let itemId, let turnId):
    let mapped = (options ?? []).map { opt in
      WorkPendingQuestionOption(
        label: opt.label,
        value: opt.value.isEmpty ? opt.label : opt.value,
        description: opt.description,
        recommended: opt.recommended ?? false,
        preview: opt.preview,
        previewFormat: opt.previewFormat
      )
    }
    return .structuredQuestion(question: question, options: mapped, itemId: itemId, turnId: turnId)
  case .approvalRequest(let itemId, _, _, let description, let turnId, let detail):
    return .approvalRequest(description: description, detail: prettyPrintedRemoteJSONValue(detail), itemId: itemId, turnId: turnId)
  case .pendingInputResolved(let itemId, let resolution, let turnId):
    return .pendingInputResolved(itemId: itemId, resolution: resolution, turnId: turnId)
  case .todoUpdate(let items, let turnId):
    let renderedItems = items.map { item in
      "\(item.status.rawValue.replacingOccurrences(of: "_", with: " ").capitalized): \(item.description)"
    }
    return .todoUpdate(items: renderedItems, turnId: turnId)
  // TODO(subagent-spawn-link): host emits `status: "subagent_spawned"` notices
  // (noticeKind "info") carrying `detail.spawnedSession { sessionId, laneId?, title? }`
  // for CLI/spawnAgent child chats. Desktop renders a tappable "Subagent spawned"
  // chip deep-linking to the child session (see AgentChatMessageList.tsx
  // "subagent_spawned" branch). iOS deliberately falls back to the generic
  // system-notice row for now (message + pretty-printed detail JSON) — a real
  // link row needs cross-session navigation plumbing (resolve child in roster,
  // thread selection up from the transcript), which is out of scope here.
  case .systemNotice(let noticeKind, let message, let detail, let turnId, let steerId):
    return .systemNotice(kind: noticeKind.rawValue, message: message, detail: prettyPrintedRemoteJSONValue(detail), turnId: turnId, steerId: steerId)
  case .error(let message, let detail, let turnId, _, let errorInfo):
    let detailText = detail ?? prettyPrintedRemoteJSONValue(errorInfo)
    return .error(message: message, detail: detailText, category: workErrorCategory(message: message, detail: detailText), turnId: turnId)
  case .done(let turnId, let status, let model, let modelId, let usage, let costUsd):
    var parts = [status.rawValue.replacingOccurrences(of: "_", with: " ").capitalized]
    if let model, !model.isEmpty {
      parts.append(model)
    }
    if let usage {
      var usageObject: [String: RemoteJSONValue] = [
        "inputTokens": .null,
        "outputTokens": .null,
        "cacheReadTokens": .null,
        "cacheCreationTokens": .null,
        "reasoningTokens": .null,
        "contextWindow": .null,
      ]
      if let inputTokens = usage.inputTokens { usageObject["inputTokens"] = .number(Double(inputTokens)) }
      if let outputTokens = usage.outputTokens { usageObject["outputTokens"] = .number(Double(outputTokens)) }
      if let cacheReadTokens = usage.cacheReadTokens { usageObject["cacheReadTokens"] = .number(Double(cacheReadTokens)) }
      if let cacheCreationTokens = usage.cacheCreationTokens { usageObject["cacheCreationTokens"] = .number(Double(cacheCreationTokens)) }
      if let reasoningTokens = usage.reasoningTokens { usageObject["reasoningTokens"] = .number(Double(reasoningTokens)) }
      if let contextWindow = usage.contextWindow { usageObject["contextWindow"] = .number(Double(contextWindow)) }
      parts.append(prettyPrintedRemoteJSONValue(.object(usageObject)))
    }
    if let costUsd {
      parts.append(String(format: "$%.4f", costUsd))
    }
    return .done(
      status: status.rawValue,
      summary: parts.joined(separator: "\n"),
      usage: makeWorkUsageSummary(
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        cacheReadTokens: usage?.cacheReadTokens,
        cacheCreationTokens: usage?.cacheCreationTokens,
        reasoningTokens: usage?.reasoningTokens,
        contextWindow: usage?.contextWindow,
        costUsd: costUsd
      ),
      turnId: turnId,
      model: model,
      modelId: modelId
    )
  case .tokens(let turnId, let itemId, let inputTokens, let outputTokens, let cacheReadTokens, let cacheWriteTokens, let contextWindow):
    return .tokens(
      usage: makeWorkUsageSummary(
        inputTokens: inputTokens,
        outputTokens: outputTokens,
        cacheReadTokens: cacheReadTokens,
        cacheCreationTokens: cacheWriteTokens,
        reasoningTokens: nil,
        totalTokens: nil,
        contextWindow: contextWindow,
        costUsd: nil
      ) ?? WorkUsageSummary(
        turnCount: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        contextWindow: contextWindow,
        costUsd: 0
      ),
      turnId: turnId,
      itemId: itemId
    )
  case .codexTokenUsage(let usage, let turnId):
    let last = usage.last
    let total = usage.total
    return .tokens(
      usage: makeWorkUsageSummary(
        inputTokens: last?.inputTokens ?? total?.inputTokens,
        outputTokens: last?.outputTokens ?? total?.outputTokens,
        cacheReadTokens: last?.cacheReadTokens ?? total?.cacheReadTokens,
        cacheCreationTokens: last?.cacheWriteTokens ?? total?.cacheWriteTokens,
        reasoningTokens: last?.reasoningTokens ?? total?.reasoningTokens,
        totalTokens: total?.totalTokens ?? last?.totalTokens,
        contextWindow: usage.modelContextWindow,
        costUsd: nil,
        isContextSnapshot: true
      ) ?? WorkUsageSummary(
        turnCount: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: total?.totalTokens ?? last?.totalTokens ?? 0,
        contextWindow: usage.modelContextWindow,
        costUsd: 0,
        isContextSnapshot: true
      ),
      turnId: turnId ?? usage.turnId ?? "",
      itemId: nil
    )
  case .contextUsage(let usage, let turnId):
    return .tokens(
      usage: WorkUsageSummary(
        turnCount: 1,
        inputTokens: usage.totalTokens,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: usage.totalTokens,
        contextWindow: usage.maxTokens,
        costUsd: 0,
        isContextSnapshot: true
      ),
      turnId: turnId ?? "",
      itemId: nil
    )
  case .promptSuggestion(let suggestion, let turnId):
    return .promptSuggestion(text: suggestion, turnId: turnId)
  case .contextCompact(
    let trigger,
    let preTokens,
    let postTokens,
    let durationMs,
    let provider,
    let sessionCompactionCount,
    let compactionId,
    let state,
    let turnId
  ):
    let isInProgress = state == .started
    let summary = workContextCompactSummary(
      trigger: trigger.rawValue,
      preTokens: preTokens,
      postTokens: postTokens,
      durationMs: durationMs,
      provider: provider,
      sessionCompactionCount: sessionCompactionCount
    )
    return .contextCompact(
      summary: summary,
      isInProgress: isInProgress,
      postTokens: postTokens,
      turnId: turnId,
      compactionId: compactionId ?? turnId
    )
  case .codexContextCompaction(let state, let trigger, let turnId, let compactionId):
    let summary = workContextCompactSummary(trigger: trigger.rawValue)
    return .contextCompact(
      summary: summary,
      isInProgress: state == .started,
      postTokens: nil,
      turnId: turnId,
      compactionId: compactionId ?? turnId
    )
  case .autoApprovalReview(_, let reviewStatus, let action, let review, let turnId):
    let summary = [reviewStatus.rawValue.capitalized, action, review].compactMap { $0 }.joined(separator: "\n")
    return .autoApprovalReview(summary: summary, turnId: turnId)
  case .webSearch(let query, let action, let actions, let itemId, let logicalItemId, let turnId, let status):
    return .webSearch(query: query, action: action, actions: actions, status: toolStatus(from: status), itemId: workStableTimelineItemId(itemId: itemId, logicalItemId: logicalItemId), turnId: turnId)
  case .codexImageGeneration(let itemId, let turnId, let prompt, let revisedPrompt, let result, let savedPath, let resultOriginalBytes, let resultOmittedBytes, let status):
    return workCodexImageGenerationEvent(
      itemId: itemId,
      turnId: turnId,
      prompt: prompt,
      revisedPrompt: revisedPrompt,
      result: result,
      savedPath: savedPath,
      resultOriginalBytes: resultOriginalBytes,
      resultOmittedBytes: resultOmittedBytes,
      status: status
    )
  case .codexImageView(let itemId, let turnId, let path, let url, let title, let urlOriginalBytes, let urlOmittedBytes, let status):
    return workCodexImageViewEvent(
      itemId: itemId,
      turnId: turnId,
      path: path,
      url: url,
      title: title,
      urlOriginalBytes: urlOriginalBytes,
      urlOmittedBytes: urlOmittedBytes,
      status: status
    )
  case .codexSafetyBuffering(let state, let turnId):
    let detail = state.fasterModel.map { "Buffering, \($0) ready" } ?? "Buffering"
    return .codexState(title: "Safety", message: detail, icon: "shield.checkered", turnId: turnId ?? state.turnId)
  case .codexModerationMetadata(_, let turnId):
    return .codexState(title: "Moderation", message: "Checked", icon: "checkmark.shield", turnId: turnId)
  case .codexSleep(_, let turnId, let durationMs, _):
    let duration = durationMs.map { $0 < 1000 ? "\($0)ms" : "\(($0 + 500) / 1000)s" }
    return .codexState(title: "Wait", message: duration.map { "Sleeping \($0)" } ?? "Sleeping", icon: "hourglass", turnId: turnId)
  case .codexThreadDeleted(_, let turnId):
    return .codexState(title: "Thread", message: "Deleted upstream. Next message starts fresh.", icon: "exclamationmark.triangle", turnId: turnId)
  case .codexTurnStalled(let turnId, _, _, let message, let recoveryOptions, let sourceSessionId):
    return .codexTurnStalled(
      message: message,
      recoveryOptions: recoveryOptions ?? [],
      turnId: turnId,
      sourceSessionId: sourceSessionId
    )
  case .planText(let text, let turnId, _):
    return .planText(text: text, turnId: turnId)
  case .toolUseSummary(let summary, _, let turnId):
    return .toolUseSummary(text: summary, turnId: turnId)
  case .status(let turnStatus, let turnId, let message):
    return .status(turnStatus: turnStatus.rawValue, message: message, turnId: turnId)
  case .reasoning(let text, let turnId, let itemId, let summaryIndex):
    return .reasoning(text: text, turnId: turnId, itemId: itemId, summaryIndex: summaryIndex)
  case .completionReport(let report, let turnId):
    return .completionReport(
      summary: report.summary,
      status: report.status,
      artifacts: (report.artifacts ?? []).map { artifact in
        WorkCompletionArtifactModel(type: artifact.type, description: artifact.description, reference: artifact.reference)
      },
      blockerDescription: report.blockerDescription,
      turnId: turnId
    )
  case .command(let command, let cwd, let output, let itemId, let logicalItemId, let turnId, let exitCode, let durationMs, let status):
    return .command(
      command: command,
      cwd: cwd,
      output: output,
      status: toolStatus(from: status),
      itemId: workStableTimelineItemId(itemId: itemId, logicalItemId: logicalItemId),
      exitCode: exitCode,
      durationMs: durationMs,
      turnId: turnId
    )
  case .fileChange(let path, let diff, let kind, let itemId, _, let turnId, let status):
    // File-change events deliberately keep the raw `itemId`: the desktop
    // emitter produces one event per file with a shared `logicalItemId` but
    // distinct raw IDs (see agentChatService `patch` handling). Collapsing to
    // `logicalItemId` would overwrite earlier paths in `buildWorkFileChangeCards`.
    return .fileChange(path: path, diff: diff, kind: kind.rawValue, status: toolStatus(from: status ?? "running"), itemId: itemId, turnId: turnId)
  case .stepBoundary:
    return .unknown(type: "step_boundary")
  case .delegationState:
    return .unknown(type: "delegation_state")
  case .unknown(let type):
    return .unknown(type: type)
  }
}

func ansiAttributedString(_ text: String) -> AttributedString {
  let key = text as NSString
  if let cached = workANSIAttributedStringCache.object(forKey: key) {
    return cached.value
  }

  var attributed = AttributedString("")
  for segment in parseANSISegments(text) {
    var piece = AttributedString(segment.text)
    piece.font = segment.bold ? .system(.footnote, design: .monospaced).bold() : .system(.footnote, design: .monospaced)
    piece.foregroundColor = ansiColor(segment.foreground)
    attributed.append(piece)
  }
  workANSIAttributedStringCache.setObject(WorkANSIAttributedStringCacheBox(attributed), forKey: key)
  return attributed
}

func ansiColor(_ color: WorkANSIColor?) -> Color {
  switch color {
  case .red: return .red
  case .green: return .green
  case .yellow: return .yellow
  case .blue: return .blue
  case .magenta: return .purple
  case .cyan: return .cyan
  case .white: return .white
  case .black: return .black
  case .none: return ADEColor.textPrimary
  }
}

func toolStatus(from raw: String) -> WorkToolCardStatus {
  switch raw.lowercased() {
  case "failed", "interrupted", "cancelled": return .failed
  case "completed", "success", "succeeded": return .completed
  default: return .running
  }
}

func icon(for status: WorkToolCardStatus) -> String {
  switch status {
  case .running: return "ellipsis.circle"
  case .completed: return "checkmark.circle.fill"
  case .failed: return "xmark.circle.fill"
  }
}

func color(for status: WorkToolCardStatus) -> Color {
  switch status {
  case .running: return ADEColor.warning
  case .completed: return ADEColor.success
  case .failed: return ADEColor.danger
  }
}

/// Returns `nil` when `value` is empty or whitespace-only. Useful for
/// normalizing the output of `prettyPrintedJSONString` (which returns "" for
/// nil/empty JSON) into an optional that downstream UI checks treat as
/// genuinely absent rather than "present but empty".
func nonEmpty(_ value: String) -> String? {
  let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
  return trimmed.isEmpty ? nil : value
}

/// Counts unified-diff `+` / `-` lines, ignoring file-header (`+++ `, `--- `)
/// and hunk-header (`@@`) lines. Mirrors the desktop `summarizeDiffStats` so
/// inline file-row stats stay consistent across platforms.
func aggregateDiffStats(_ diff: String) -> (additions: Int, deletions: Int) {
  var additions = 0
  var deletions = 0
  diff.enumerateLines { line, _ in
    if line.isEmpty { return }
    if line.hasPrefix("+++ ") || line.hasPrefix("--- ") || line.hasPrefix("@@") { return }
    if line.hasPrefix("+") { additions += 1 }
    else if line.hasPrefix("-") { deletions += 1 }
  }
  return (additions, deletions)
}

func prettyPrintedJSONString(_ value: Any?) -> String {
  guard let value else { return "" }
  if let string = value as? String {
    return string
  }
  if JSONSerialization.isValidJSONObject(value),
     let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]),
     let string = String(data: data, encoding: .utf8) {
    return string
  }
  return String(describing: value)
}

func prettyPrintedRemoteJSONValue(_ value: RemoteJSONValue?) -> String {
  guard let value else { return "" }
  let foundationObject = foundationObject(from: value)
  return prettyPrintedJSONString(foundationObject)
}

func foundationObject(from value: RemoteJSONValue) -> Any {
  switch value {
  case .string(let string):
    return string
  case .number(let number):
    return number
  case .bool(let bool):
    return bool
  case .object(let object):
    return object.mapValues { foundationObject(from: $0) }
  case .array(let array):
    return array.map { foundationObject(from: $0) }
  case .null:
    return NSNull()
  }
}

func stringValue(_ value: Any?) -> String {
  if let string = value as? String {
    return string
  }
  if let number = value as? NSNumber {
    return number.stringValue
  }
  return ""
}

func optionalString(_ value: Any?) -> String? {
  let text = stringValue(value).trimmingCharacters(in: .whitespacesAndNewlines)
  return text.isEmpty ? nil : text
}
