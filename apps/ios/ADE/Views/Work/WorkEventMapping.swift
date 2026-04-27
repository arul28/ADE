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
  case .userMessage(let text, _, let turnId, let steerId, let deliveryState, let processed):
    return .userMessage(text: text, turnId: turnId, steerId: steerId, deliveryState: deliveryState, processed: processed)
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
  case .plan(let steps, let explanation, let turnId):
    let mapped = steps.map { WorkPlanStep(text: $0.text, status: $0.status) }
    return .plan(steps: mapped, explanation: explanation, turnId: turnId)
  case .subagentStarted(let taskId, let description, let background, let turnId):
    return .subagentStarted(taskId: taskId, description: description, background: background ?? false, turnId: turnId)
  case .subagentProgress(let taskId, let description, let summary, _, let lastToolName, let turnId):
    return .subagentProgress(taskId: taskId, description: description, summary: summary, toolName: lastToolName, turnId: turnId)
  case .subagentResult(let taskId, let status, let summary, _, let turnId):
    return .subagentResult(taskId: taskId, status: status.rawValue, summary: summary, turnId: turnId)
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
  case .systemNotice(let noticeKind, let message, let detail, let turnId, let steerId):
    return .systemNotice(kind: noticeKind.rawValue, message: message, detail: prettyPrintedRemoteJSONValue(detail), turnId: turnId, steerId: steerId)
  case .error(let message, let turnId, _, let errorInfo):
    let detailText = prettyPrintedRemoteJSONValue(errorInfo)
    return .error(message: message, detail: detailText, category: workErrorCategory(message: message, detail: detailText), turnId: turnId)
  case .done(let turnId, let status, let model, let modelId, let usage, let costUsd):
    var parts = [status.rawValue.replacingOccurrences(of: "_", with: " ").capitalized]
    if let model, !model.isEmpty {
      parts.append(model)
    }
    if let usage {
      parts.append(prettyPrintedRemoteJSONValue(.object([
        "inputTokens": usage.inputTokens.map { .number(Double($0)) } ?? .null,
        "outputTokens": usage.outputTokens.map { .number(Double($0)) } ?? .null,
        "cacheReadTokens": usage.cacheReadTokens.map { .number(Double($0)) } ?? .null,
        "cacheCreationTokens": usage.cacheCreationTokens.map { .number(Double($0)) } ?? .null,
      ])))
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
        costUsd: costUsd
      ),
      turnId: turnId,
      model: model,
      modelId: modelId
    )
  case .promptSuggestion(let suggestion, let turnId):
    return .promptSuggestion(text: suggestion, turnId: turnId)
  case .contextCompact(let trigger, let preTokens, let turnId):
    let summary = [trigger.rawValue.capitalized, preTokens.map { "Pre-compact tokens: \($0)" }].compactMap { $0 }.joined(separator: "\n")
    return .contextCompact(summary: summary, turnId: turnId)
  case .autoApprovalReview(_, let reviewStatus, let action, let review, let turnId):
    let summary = [reviewStatus.rawValue.capitalized, action, review].compactMap { $0 }.joined(separator: "\n")
    return .autoApprovalReview(summary: summary, turnId: turnId)
  case .webSearch(let query, let action, let itemId, let logicalItemId, let turnId, let status):
    return .webSearch(query: query, action: action, status: toolStatus(from: status), itemId: workStableTimelineItemId(itemId: itemId, logicalItemId: logicalItemId), turnId: turnId)
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
