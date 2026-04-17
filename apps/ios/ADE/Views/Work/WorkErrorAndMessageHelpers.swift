import SwiftUI
import UIKit
import AVKit

struct WorkErrorPresentation {
  let title: String
  let icon: String
  let tint: ColorToken
}

func errorPresentation(for category: String) -> WorkErrorPresentation {
  switch category {
  case "auth":
    return WorkErrorPresentation(title: "Authentication issue", icon: "lock.trianglebadge.exclamationmark", tint: .danger)
  case "rate_limit":
    return WorkErrorPresentation(title: "Rate limited", icon: "hourglass", tint: .warning)
  case "network":
    return WorkErrorPresentation(title: "Connection issue", icon: "wifi.exclamationmark", tint: .warning)
  case "permission":
    return WorkErrorPresentation(title: "Permission issue", icon: "hand.raised.fill", tint: .warning)
  default:
    return WorkErrorPresentation(title: "Error", icon: "exclamationmark.triangle.fill", tint: .danger)
  }
}

func buildWorkChatMessages(from transcript: [WorkChatEnvelope]) -> [WorkChatMessage] {
  var messages: [WorkChatMessage] = []

  for envelope in transcript {
    switch envelope.event {
    case .userMessage(let text, let turnId, let steerId, let deliveryState, let processed):
      // Queued steers render as inline cards above the composer, not in the message stream.
      if deliveryState == "queued", steerId != nil {
        continue
      }
      if let lastIndex = messages.indices.last,
         messages[lastIndex].role == "user",
         messages[lastIndex].turnId == turnId,
         messages[lastIndex].steerId == steerId,
         messages[lastIndex].timestamp == envelope.timestamp {
        messages[lastIndex].markdown += text
        if let deliveryState {
          messages[lastIndex].deliveryState = deliveryState
        }
        if let processed {
          messages[lastIndex].processed = processed
        }
      } else {
        messages.append(WorkChatMessage(
          id: envelope.id,
          role: "user",
          markdown: text,
          timestamp: envelope.timestamp,
          turnId: turnId,
          itemId: nil,
          steerId: steerId,
          deliveryState: deliveryState,
          processed: processed
        ))
      }
    case .assistantText(let text, let turnId, let itemId):
      if let lastIndex = messages.indices.last,
         messages[lastIndex].role == "assistant",
         messages[lastIndex].turnId == turnId,
         messages[lastIndex].itemId == itemId {
        messages[lastIndex].markdown += text
      } else {
        messages.append(WorkChatMessage(id: envelope.id, role: "assistant", markdown: text, timestamp: envelope.timestamp, turnId: turnId, itemId: itemId))
      }
    default:
      continue
    }
  }

  return messages
}

func makeWorkChatTranscript(from entries: [AgentChatTranscriptEntry], sessionId: String) -> [WorkChatEnvelope] {
  entries.map { entry in
    WorkChatEnvelope(
      sessionId: sessionId,
      timestamp: entry.timestamp,
      sequence: nil,
      event: entry.role == "assistant"
        ? .assistantText(text: entry.text, turnId: entry.turnId, itemId: nil)
        : .userMessage(text: entry.text, turnId: entry.turnId, steerId: nil, deliveryState: nil, processed: nil)
    )
  }
}

func makeWorkChatTranscript(from entries: [AgentChatEventEnvelope]) -> [WorkChatEnvelope] {
  entries.map { entry in
    WorkChatEnvelope(
      sessionId: entry.sessionId,
      timestamp: entry.timestamp,
      sequence: entry.sequence,
      event: makeWorkChatEvent(from: entry.event)
    )
  }
  .sorted { lhs, rhs in
    if lhs.timestamp == rhs.timestamp {
      return (lhs.sequence ?? 0) < (rhs.sequence ?? 0)
    }
    return lhs.timestamp < rhs.timestamp
  }
}

func mergeWorkChatTranscripts(base: [WorkChatEnvelope], live: [WorkChatEnvelope]) -> [WorkChatEnvelope] {
  guard !live.isEmpty else { return base }
  guard !base.isEmpty else { return live }

  var merged: [WorkChatEnvelope] = []
  merged.reserveCapacity(base.count + live.count)
  var indexByKey: [String: Int] = [:]

  for envelope in base + live {
    let key = workChatEnvelopeMergeKey(envelope)
    if let existing = indexByKey[key] {
      merged[existing] = envelope
    } else {
      indexByKey[key] = merged.count
      merged.append(envelope)
    }
  }

  return merged.sorted { lhs, rhs in
    if lhs.timestamp == rhs.timestamp {
      return (lhs.sequence ?? 0) < (rhs.sequence ?? 0)
    }
    return lhs.timestamp < rhs.timestamp
  }
}

enum WorkPendingInputItem: Identifiable, Equatable {
  case approval(WorkPendingApprovalModel)
  case question(WorkPendingQuestionModel)

  var id: String {
    switch self {
    case .approval(let model): return "approval:\(model.id)"
    case .question(let model): return "question:\(model.id)"
    }
  }

  var itemId: String {
    switch self {
    case .approval(let model): return model.id
    case .question(let model): return model.id
    }
  }
}

struct WorkPendingSteerModel: Identifiable, Equatable {
  let id: String
  var text: String
  let turnId: String?
  let timestamp: String
}

/// Ordered list of still-open pending inputs (approvals + structured questions) in the order
/// they were requested. Mirrors the desktop `derivePendingInputRequests` helper — resolved items
/// are filtered out using the same predicate as `pendingWorkInputItemIds`.
func derivePendingWorkInputs(from transcript: [WorkChatEnvelope]) -> [WorkPendingInputItem] {
  let openIds = pendingWorkInputItemIds(from: transcript)
  var seen = Set<String>()
  var results: [WorkPendingInputItem] = []
  for envelope in sortedWorkChatEnvelopes(transcript) {
    switch envelope.event {
    case .approvalRequest(let description, let detail, let itemId, _):
      guard openIds.contains(itemId), !seen.contains(itemId) else { continue }
      seen.insert(itemId)
      results.append(.approval(WorkPendingApprovalModel(id: itemId, description: description, detail: detail)))
    case .structuredQuestion(let question, let options, let itemId, _):
      guard openIds.contains(itemId), !seen.contains(itemId) else { continue }
      seen.insert(itemId)
      results.append(.question(WorkPendingQuestionModel(id: itemId, question: question, options: options)))
    default:
      continue
    }
  }
  return results
}

/// Ordered list of queued steer messages (user messages with `deliveryState == "queued"` and a
/// `steerId`). Removed once a `system_notice` referencing the same steerId arrives (desktop emits
/// one for both "cancelled" and "delivering") or once the event graduates out of the queued state.
func derivePendingWorkSteers(from transcript: [WorkChatEnvelope]) -> [WorkPendingSteerModel] {
  var queue: [String: WorkPendingSteerModel] = [:]
  var order: [String] = []
  var resolved = Set<String>()
  for envelope in sortedWorkChatEnvelopes(transcript) {
    switch envelope.event {
    case .userMessage(let text, let turnId, let steerId, let deliveryState, _):
      guard let steerId, !resolved.contains(steerId) else { continue }
      if deliveryState == "queued" {
        if queue[steerId] == nil { order.append(steerId) }
        queue[steerId] = WorkPendingSteerModel(id: steerId, text: text, turnId: turnId, timestamp: envelope.timestamp)
      } else if deliveryState == "delivered" || deliveryState == "failed" {
        queue.removeValue(forKey: steerId)
        resolved.insert(steerId)
      }
    case .systemNotice(_, _, _, _, let steerId):
      if let steerId {
        queue.removeValue(forKey: steerId)
        resolved.insert(steerId)
      }
    default:
      continue
    }
  }
  return order.compactMap { queue[$0] }
}

func pendingWorkInputItemIds(from transcript: [WorkChatEnvelope]) -> Set<String> {
  var approvals: [String: String?] = [:]
  var questions: [String: String?] = [:]

  for envelope in sortedWorkChatEnvelopes(transcript) {
    switch envelope.event {
    case .approvalRequest(_, _, let itemId, let turnId):
      approvals.updateValue(turnId, forKey: itemId)
    case .structuredQuestion(_, _, let itemId, let turnId):
      questions.updateValue(turnId, forKey: itemId)
    case .pendingInputResolved(let itemId, _, _):
      approvals.removeValue(forKey: itemId)
      questions.removeValue(forKey: itemId)
    case .toolResult(_, _, let itemId, _, _, _),
         .command(_, _, _, _, let itemId, _, _, _),
         .fileChange(_, _, _, _, let itemId, _):
      approvals.removeValue(forKey: itemId)
      questions.removeValue(forKey: itemId)
    case .done(let status, _, _, let turnId):
      if status == "completed" {
        approvals = approvals.filter { $0.value != turnId }
      } else {
        approvals.removeAll()
        questions.removeAll()
      }
    default:
      continue
    }
  }

  return Set(approvals.keys).union(questions.keys)
}

func sortedWorkChatEnvelopes(_ transcript: [WorkChatEnvelope]) -> [WorkChatEnvelope] {
  transcript.sorted { lhs, rhs in
    if lhs.timestamp == rhs.timestamp {
      return (lhs.sequence ?? 0) < (rhs.sequence ?? 0)
    }
    return lhs.timestamp < rhs.timestamp
  }
}

func workChatEnvelopeMergeKey(_ envelope: WorkChatEnvelope) -> String {
  "\(envelope.sessionId)|\(envelope.timestamp)|\(workChatEventMergeKey(envelope.event))"
}

func workChatEventMergeKey(_ event: WorkChatEvent) -> String {
  switch event {
  case .userMessage(let text, let turnId, let steerId, let deliveryState, let processed):
    // Queued steers are uniquely identified by steerId so that editSteer replaces the existing
    // entry in place instead of spawning a duplicate row whose only difference is the edited text.
    if let steerId, deliveryState == "queued" {
      return ["user_message", turnId ?? "", steerId, "queued"].joined(separator: "|")
    }
    return ["user_message", turnId ?? "", steerId ?? "", deliveryState ?? "", processed.map { $0 ? "1" : "0" } ?? "", text].joined(separator: "|")
  case .assistantText(let text, let turnId, let itemId):
    return ["text", turnId ?? "", itemId ?? "", text].joined(separator: "|")
  case .toolCall(let tool, let argsText, let itemId, let parentItemId, let turnId):
    return ["tool_call", turnId ?? "", itemId, parentItemId ?? "", tool, argsText].joined(separator: "|")
  case .toolResult(let tool, let resultText, let itemId, let parentItemId, let turnId, let status):
    return ["tool_result", turnId ?? "", itemId, parentItemId ?? "", tool, status.rawValue, resultText].joined(separator: "|")
  case .activity(let kind, let detail, let turnId):
    return ["activity", turnId ?? "", kind, detail ?? ""].joined(separator: "|")
  case .plan(let steps, let explanation, let turnId):
    let stepDigest = steps.map { "\($0.status):\($0.text)" }.joined(separator: "\n")
    return ["plan", turnId ?? "", explanation ?? "", stepDigest].joined(separator: "|")
  case .subagentStarted(let taskId, let description, let background, let turnId):
    return ["subagent_started", turnId ?? "", taskId, description, background ? "1" : "0"].joined(separator: "|")
  case .subagentProgress(let taskId, let description, let summary, let toolName, let turnId):
    return ["subagent_progress", turnId ?? "", taskId, description ?? "", summary, toolName ?? ""].joined(separator: "|")
  case .subagentResult(let taskId, let status, let summary, let turnId):
    return ["subagent_result", turnId ?? "", taskId, status, summary].joined(separator: "|")
  case .structuredQuestion(let question, let options, let itemId, let turnId):
    return ["structured_question", turnId ?? "", itemId, question, options.joined(separator: "\n")].joined(separator: "|")
  case .approvalRequest(let description, let detail, let itemId, let turnId):
    return ["approval_request", turnId ?? "", itemId, description, detail ?? ""].joined(separator: "|")
  case .pendingInputResolved(let itemId, let resolution, let turnId):
    return ["pending_input_resolved", turnId ?? "", itemId, resolution].joined(separator: "|")
  case .todoUpdate(let items, let turnId):
    return ["todo_update", turnId ?? "", items.joined(separator: "\n")].joined(separator: "|")
  case .systemNotice(let kind, let message, let detail, let turnId, let steerId):
    return ["system_notice", turnId ?? "", steerId ?? "", kind, message, detail ?? ""].joined(separator: "|")
  case .error(let message, let detail, let category, let turnId):
    return ["error", turnId ?? "", category, message, detail ?? ""].joined(separator: "|")
  case .done(let status, let summary, let usage, let turnId):
    return ["done", turnId, status, summary, workUsageSummaryMergeKey(usage)].joined(separator: "|")
  case .promptSuggestion(let text, let turnId):
    return ["prompt_suggestion", turnId ?? "", text].joined(separator: "|")
  case .contextCompact(let summary, let turnId):
    return ["context_compact", turnId ?? "", summary].joined(separator: "|")
  case .autoApprovalReview(let summary, let turnId):
    return ["auto_approval_review", turnId ?? "", summary].joined(separator: "|")
  case .webSearch(let query, let action, let status, let itemId, let turnId):
    return ["web_search", turnId ?? "", itemId, query, action ?? "", status.rawValue].joined(separator: "|")
  case .planText(let text, let turnId):
    return ["plan_text", turnId ?? "", text].joined(separator: "|")
  case .toolUseSummary(let text, let turnId):
    return ["tool_use_summary", turnId ?? "", text].joined(separator: "|")
  case .status(let turnStatus, let message, let turnId):
    return ["status", turnId ?? "", turnStatus, message ?? ""].joined(separator: "|")
  case .reasoning(let text, let turnId):
    return ["reasoning", turnId ?? "", text].joined(separator: "|")
  case .completionReport(let summary, let status, let artifacts, let blockerDescription, let turnId):
    return ["completion_report", turnId ?? "", status, summary, blockerDescription ?? "", workCompletionArtifactsMergeKey(artifacts)].joined(separator: "|")
  case .command(let command, let cwd, let output, let status, let itemId, let exitCode, let durationMs, let turnId):
    return [
      "command",
      turnId ?? "",
      itemId,
      command,
      cwd,
      output,
      status.rawValue,
      exitCode.map { String($0) } ?? "",
      durationMs.map { String($0) } ?? "",
    ].joined(separator: "|")
  case .fileChange(let path, let diff, let kind, let status, let itemId, let turnId):
    return ["file_change", turnId ?? "", itemId, path, kind, status.rawValue, diff].joined(separator: "|")
  case .unknown(let type):
    return ["unknown", type].joined(separator: "|")
  }
}

func workUsageSummaryMergeKey(_ usage: WorkUsageSummary?) -> String {
  guard let usage else { return "" }
  return [
    String(usage.turnCount),
    String(usage.inputTokens),
    String(usage.outputTokens),
    String(usage.cacheReadTokens),
    String(usage.cacheCreationTokens),
    String(usage.costUsd),
  ].joined(separator: "|")
}

func workCompletionArtifactsMergeKey(_ artifacts: [WorkCompletionArtifactModel]) -> String {
  artifacts.map { artifact in
    [artifact.type, artifact.description, artifact.reference ?? ""].joined(separator: "~")
  }.joined(separator: "\n")
}
