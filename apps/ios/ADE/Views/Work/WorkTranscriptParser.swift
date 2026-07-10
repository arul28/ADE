import SwiftUI
import UIKit
import AVKit

func workFallbackItemID(
  sessionId: String,
  timestamp: String,
  sequence: Int?,
  type: String,
  seed: String
) -> String {
  "fallback-\(workStableDigest([sessionId, timestamp, String(sequence ?? -1), type, seed].joined(separator: "|")))"
}

func optionalWorkInt(_ value: Any?) -> Int? {
  if let value = value as? Int { return value }
  if let value = value as? NSNumber { return value.intValue }
  if let value = value as? String { return Int(value.trimmingCharacters(in: .whitespacesAndNewlines)) }
  return nil
}

private func parseCodexWebSearchActions(from value: Any?) -> [CodexWebSearchAction]? {
  guard let rawActions = value as? [[String: Any]] else { return nil }
  let actions = rawActions.compactMap { action -> CodexWebSearchAction? in
    guard let type = optionalString(action["type"]) else { return nil }
    let queries = (action["queries"] as? [Any])?.compactMap(optionalString)
    return CodexWebSearchAction(
      type: type,
      status: optionalString(action["status"]),
      query: optionalString(action["query"]),
      queries: queries?.isEmpty == true ? nil : queries,
      url: optionalString(action["url"]),
      title: optionalString(action["title"]),
      snippet: optionalString(action["snippet"])
    )
  }
  return actions.isEmpty ? nil : actions
}

private func workTranscriptToolName(from eventDict: [String: Any]) -> String {
  let fallback = stringValue(eventDict["tool"])
  guard let mcp = eventDict["mcp"] as? [String: Any] else { return fallback }
  let appContext = mcp["appContext"] as? [String: Any]
  let source = optionalString(appContext?["appName"])
    ?? optionalString(mcp["server"])
  let action = optionalString(mcp["tool"])
  guard let source, let action else { return fallback }
  return "\(source):\(action)"
}

private func formatWorkCompactTokenCount(_ value: Int) -> String {
  if value >= 1_000_000 { return String(format: "%.1fM", Double(value) / 1_000_000.0) }
  if value >= 10_000 { return "\(Int((Double(value) / 1_000.0).rounded()))k" }
  if value >= 1_000 { return String(format: "%.1fk", Double(value) / 1_000.0) }
  return "\(value)"
}

func workContextCompactSummary(
  trigger: String,
  preTokens: Int? = nil,
  postTokens: Int? = nil,
  durationMs: Int? = nil,
  provider: String? = nil,
  sessionCompactionCount: Int? = nil
) -> String {
  var lines: [String] = []
  if let provider {
    lines.append("provider:\(provider)")
  }
  if let sessionCount = sessionCompactionCount, sessionCount >= 2 {
    lines.append("sessionCount:\(sessionCount)")
  }
  let triggerLabel = trigger.replacingOccurrences(of: "_", with: " ").capitalized
  lines.append(triggerLabel)
  if let pre = preTokens, let post = postTokens {
    lines.append("\(formatWorkCompactTokenCount(pre)) → \(formatWorkCompactTokenCount(post))")
  } else if let pre = preTokens {
    lines.append("Pre-compact tokens: \(pre)")
  }
  if let durationMs {
    lines.append("duration:\(durationMs)ms")
  }
  return lines.joined(separator: "\n")
}

func workContextCompactSummary(from eventDict: [String: Any]) -> String {
  workContextCompactSummary(
    trigger: stringValue(eventDict["trigger"]),
    preTokens: optionalWorkInt(eventDict["preTokens"]),
    postTokens: optionalWorkInt(eventDict["postTokens"]),
    durationMs: optionalWorkInt(eventDict["durationMs"]),
    provider: optionalString(eventDict["provider"]),
    sessionCompactionCount: optionalWorkInt(eventDict["sessionCompactionCount"])
  )
}

func workContextCompactMergeId(from eventDict: [String: Any], turnId: String?) -> String? {
  if let compactionId = optionalString(eventDict["compactionId"]) {
    return compactionId
  }
  return turnId
}

func parseWorkChatTranscript(_ raw: String) -> [WorkChatEnvelope] {
  extractLooseJSONObjects(from: raw)
    .compactMap { chunk -> WorkChatEnvelope? in
      let normalizedChunk = sanitizeLooseJSONControlCharacters(in: chunk)
      guard let data = normalizedChunk.data(using: .utf8),
            let envelope = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
            let sessionId = envelope["sessionId"] as? String,
            let timestamp = envelope["timestamp"] as? String,
            let eventDict = envelope["event"] as? [String: Any],
            let type = eventDict["type"] as? String
      else {
        return nil
      }

      let sequence = envelope["sequence"] as? Int
      let turnId = eventDict["turnId"] as? String
      let itemId = eventDict["itemId"] as? String
      let logicalItemId = eventDict["logicalItemId"] as? String
      let stableToolItemId = workStableTimelineItemId(itemId: itemId, logicalItemId: logicalItemId)
      let parentItemId = eventDict["parentItemId"] as? String
      let subagentTaskType = optionalString(eventDict["taskType"])
        ?? optionalString(eventDict["task_type"])
      let subagentCommand = optionalString(eventDict["command"])
      let event: WorkChatEvent

      switch type {
      case "user_message":
        event = .userMessage(
          text: userMessageDisplayText(from: eventDict),
          attachments: parseAgentChatFileRefs(from: eventDict["attachments"]),
          turnId: turnId,
          steerId: optionalString(eventDict["steerId"]),
          deliveryState: optionalString(eventDict["deliveryState"]),
          processed: eventDict["processed"] as? Bool
        )
      case "text":
        event = .assistantText(
          text: stringValue(eventDict["text"]),
          turnId: turnId,
          itemId: optionalString(eventDict["itemId"]) ?? optionalString(eventDict["messageId"])
        )
      case "tool_call":
        event = .toolCall(
          tool: workTranscriptToolName(from: eventDict),
          argsText: prettyPrintedJSONString(eventDict["args"]),
          itemId: stableToolItemId ?? workFallbackItemID(
            sessionId: sessionId,
            timestamp: timestamp,
            sequence: sequence,
            type: type,
            seed: [
              "tool_call",
              turnId ?? "",
              parentItemId ?? "",
              stringValue(eventDict["tool"]),
              prettyPrintedJSONString(eventDict["args"]),
            ].joined(separator: "|")
          ),
          parentItemId: parentItemId,
          turnId: turnId
        )
      case "tool_result":
        event = .toolResult(
          tool: workTranscriptToolName(from: eventDict),
          resultText: prettyPrintedJSONString(eventDict["result"]),
          itemId: stableToolItemId ?? workFallbackItemID(
            sessionId: sessionId,
            timestamp: timestamp,
            sequence: sequence,
            type: type,
            seed: [
              "tool_result",
              turnId ?? "",
              parentItemId ?? "",
              stringValue(eventDict["tool"]),
              stringValue(eventDict["status"]),
              prettyPrintedJSONString(eventDict["result"]),
            ].joined(separator: "|")
          ),
          parentItemId: parentItemId,
          turnId: turnId,
          status: toolStatus(from: stringValue(eventDict["status"]))
        )
      case "activity":
        event = .activity(kind: stringValue(eventDict["activity"]), detail: optionalString(eventDict["detail"]), turnId: turnId)
      case "plan":
        let steps = (eventDict["steps"] as? [[String: Any]] ?? []).map { step in
          WorkPlanStep(
            text: stringValue(step["description"]),
            status: stringValue(step["status"])
          )
        }
        event = .plan(steps: steps, explanation: optionalString(eventDict["explanation"]), turnId: turnId)
      case "subagent_started":
        event = .subagentStarted(
          taskId: stringValue(eventDict["taskId"]),
          agentId: optionalString(eventDict["agentId"]),
          agentType: optionalString(eventDict["agentType"]),
          parentToolUseId: optionalString(eventDict["parentToolUseId"]) ?? optionalString(eventDict["parentAgentId"]),
          description: stringValue(eventDict["description"]),
          background: (eventDict["background"] as? Bool) ?? false,
          label: optionalString(eventDict["label"]),
          model: optionalString(eventDict["model"]),
          reasoningEffort: optionalString(eventDict["reasoningEffort"]),
          turnId: turnId
        )
      case "subagent_progress":
        event = .subagentProgress(
          taskId: stringValue(eventDict["taskId"]),
          agentId: optionalString(eventDict["agentId"]),
          agentType: optionalString(eventDict["agentType"]),
          parentToolUseId: optionalString(eventDict["parentToolUseId"]) ?? optionalString(eventDict["parentAgentId"]),
          description: optionalString(eventDict["description"]),
          summary: stringValue(eventDict["summary"]),
          toolName: optionalString(eventDict["lastToolName"]),
          label: optionalString(eventDict["label"]),
          model: optionalString(eventDict["model"]),
          reasoningEffort: optionalString(eventDict["reasoningEffort"]),
          turnId: turnId
        )
      case "subagent_result":
        event = .subagentResult(
          taskId: stringValue(eventDict["taskId"]),
          agentId: optionalString(eventDict["agentId"]),
          agentType: optionalString(eventDict["agentType"]),
          parentToolUseId: optionalString(eventDict["parentToolUseId"]) ?? optionalString(eventDict["parentAgentId"]),
          status: stringValue(eventDict["status"]),
          summary: stringValue(eventDict["summary"]),
          label: optionalString(eventDict["label"]),
          model: optionalString(eventDict["model"]),
          reasoningEffort: optionalString(eventDict["reasoningEffort"]),
          turnId: turnId
        )
      case "scheduled_work_update":
        event = .scheduledWorkUpdate(
          id: stringValue(eventDict["id"]),
          kind: stringValue(eventDict["kind"]),
          status: stringValue(eventDict["status"]),
          origin: optionalString(eventDict["origin"]),
          title: optionalString(eventDict["title"]),
          summary: optionalString(eventDict["summary"]),
          prompt: optionalString(eventDict["prompt"]),
          reason: optionalString(eventDict["reason"]),
          cron: optionalString(eventDict["cron"]),
          nextRunAt: optionalString(eventDict["nextRunAt"]),
          lastRunAt: optionalString(eventDict["lastRunAt"]),
          recurring: workBoolValue(eventDict["recurring"]),
          durable: workBoolValue(eventDict["durable"]),
          sourceToolUseId: optionalString(eventDict["sourceToolUseId"]),
          sourceTaskId: optionalString(eventDict["sourceTaskId"]),
          turnId: turnId,
          error: optionalString(eventDict["error"])
        )
      case "transcript_retraction":
        let messageIds = (eventDict["messageIds"] as? [Any] ?? []).compactMap(optionalString)
        event = .transcriptRetraction(
          messageIds: messageIds,
          reason: optionalString(eventDict["reason"]),
          replacementMessageId: optionalString(eventDict["replacementMessageId"]),
          turnId: turnId
        )
      case "status":
        event = .status(turnStatus: stringValue(eventDict["turnStatus"]), message: optionalString(eventDict["message"]), turnId: turnId)
      case "reasoning":
        event = .reasoning(
          text: stringValue(eventDict["text"]),
          turnId: turnId,
          itemId: itemId,
          summaryIndex: eventDict["summaryIndex"] as? Int
        )
      case "approval_request":
        event = .approvalRequest(
          description: stringValue(eventDict["description"]),
          detail: optionalString(prettyPrintedJSONString(eventDict["detail"])),
          itemId: itemId ?? workFallbackItemID(
            sessionId: sessionId,
            timestamp: timestamp,
            sequence: sequence,
            type: type,
            seed: [
              "approval_request",
              turnId ?? "",
              stringValue(eventDict["description"]),
              prettyPrintedJSONString(eventDict["detail"]),
            ].joined(separator: "|")
          ),
          turnId: turnId
        )
      case "pending_input_resolved":
        event = .pendingInputResolved(
          itemId: itemId ?? workFallbackItemID(
            sessionId: sessionId,
            timestamp: timestamp,
            sequence: sequence,
            type: type,
            seed: [
              "pending_input_resolved",
              turnId ?? "",
              stringValue(eventDict["resolution"]),
            ].joined(separator: "|")
          ),
          resolution: stringValue(eventDict["resolution"]),
          turnId: turnId
        )
      case "structured_question":
        let rawOptions = eventDict["options"] as? [[String: Any]] ?? []
        let options = rawOptions.compactMap { workPendingQuestionOption(from: $0) }
        event = .structuredQuestion(
          question: stringValue(eventDict["question"]),
          options: options,
          itemId: itemId ?? workFallbackItemID(
            sessionId: sessionId,
            timestamp: timestamp,
            sequence: sequence,
            type: type,
            seed: [
              "structured_question",
              turnId ?? "",
              stringValue(eventDict["question"]),
              options.map(\.label).joined(separator: "|"),
            ].joined(separator: "|")
          ),
          turnId: turnId
        )
      case "todo_update":
        let items = (eventDict["items"] as? [[String: Any]] ?? []).map { item in
          let status = stringValue(item["status"]).replacingOccurrences(of: "_", with: " ").capitalized
          let description = stringValue(item["description"])
          return description.isEmpty ? status : "\(status): \(description)"
        }
        event = .todoUpdate(items: items, turnId: turnId)
      case "system_notice":
        event = .systemNotice(
          kind: stringValue(eventDict["noticeKind"]),
          message: stringValue(eventDict["message"]),
          detail: optionalString(prettyPrintedJSONString(eventDict["detail"])),
          turnId: turnId,
          steerId: optionalString(eventDict["steerId"])
        )
      case "error":
        let explicitDetail = optionalString(eventDict["detail"])
        let detailText = explicitDetail ?? optionalString(prettyPrintedJSONString(eventDict["errorInfo"]))
        event = .error(
          message: stringValue(eventDict["message"]),
          detail: detailText,
          category: workErrorCategory(message: stringValue(eventDict["message"]), detail: detailText),
          turnId: turnId
        )
      case "done":
        let usage = prettyPrintedJSONString(eventDict["usage"])
        let cost = eventDict["costUsd"] as? NSNumber
        let usageDict = eventDict["usage"] as? [String: Any]
        var summaryParts: [String] = []
        if let status = optionalString(eventDict["status"]) {
          summaryParts.append(status.replacingOccurrences(of: "_", with: " ").capitalized)
        }
        if let model = optionalString(eventDict["model"]) {
          summaryParts.append(model)
        }
        if !usage.isEmpty {
          summaryParts.append(usage)
        }
        if let cost {
          summaryParts.append(String(format: "$%.4f", cost.doubleValue))
        }
        let usageSummary = makeWorkUsageSummary(
          inputTokens: optionalWorkInt(usageDict?["inputTokens"]),
          outputTokens: optionalWorkInt(usageDict?["outputTokens"]),
          cacheReadTokens: optionalWorkInt(usageDict?["cacheReadTokens"]),
          cacheCreationTokens: optionalWorkInt(usageDict?["cacheCreationTokens"]),
          reasoningTokens: optionalWorkInt(usageDict?["reasoningTokens"]),
          totalTokens: optionalWorkInt(usageDict?["totalTokens"]),
          contextWindow: optionalWorkInt(usageDict?["contextWindow"]),
          costUsd: cost?.doubleValue
        )
        event = .done(
          status: stringValue(eventDict["status"]),
          summary: summaryParts.joined(separator: "\n"),
          usage: usageSummary,
          turnId: stringValue(eventDict["turnId"]),
          model: optionalString(eventDict["model"]),
          modelId: optionalString(eventDict["modelId"])
        )
      case "tokens":
        event = .tokens(
          usage: makeWorkUsageSummary(
            inputTokens: optionalWorkInt(eventDict["inputTokens"]),
            outputTokens: optionalWorkInt(eventDict["outputTokens"]),
            cacheReadTokens: optionalWorkInt(eventDict["cacheReadTokens"]),
            cacheCreationTokens: optionalWorkInt(eventDict["cacheWriteTokens"]),
            reasoningTokens: nil,
            totalTokens: optionalWorkInt(eventDict["totalTokens"]),
            contextWindow: optionalWorkInt(eventDict["contextWindow"]),
            costUsd: nil
          ) ?? WorkUsageSummary(
            turnCount: 1,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            totalTokens: optionalWorkInt(eventDict["totalTokens"]) ?? 0,
            contextWindow: optionalWorkInt(eventDict["contextWindow"]),
            costUsd: 0
          ),
          turnId: stringValue(eventDict["turnId"]),
          itemId: itemId
        )
      case "codex_token_usage":
        let usageDict = eventDict["usage"] as? [String: Any] ?? [:]
        let lastUsage = usageDict["last"] as? [String: Any]
        let totalUsage = usageDict["total"] as? [String: Any]
        let contextWindow = optionalWorkInt(usageDict["modelContextWindow"])
        event = .tokens(
          usage: makeWorkUsageSummary(
            inputTokens: optionalWorkInt(lastUsage?["inputTokens"]) ?? optionalWorkInt(totalUsage?["inputTokens"]),
            outputTokens: optionalWorkInt(lastUsage?["outputTokens"]) ?? optionalWorkInt(totalUsage?["outputTokens"]),
            cacheReadTokens: optionalWorkInt(lastUsage?["cacheReadTokens"]) ?? optionalWorkInt(totalUsage?["cacheReadTokens"]),
            cacheCreationTokens: optionalWorkInt(lastUsage?["cacheWriteTokens"]) ?? optionalWorkInt(totalUsage?["cacheWriteTokens"]),
            reasoningTokens: optionalWorkInt(lastUsage?["reasoningTokens"]) ?? optionalWorkInt(totalUsage?["reasoningTokens"]),
            totalTokens: optionalWorkInt(totalUsage?["totalTokens"]) ?? optionalWorkInt(lastUsage?["totalTokens"]),
            contextWindow: contextWindow,
            costUsd: nil
          ) ?? WorkUsageSummary(
            turnCount: 1,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            totalTokens: optionalWorkInt(totalUsage?["totalTokens"]) ?? optionalWorkInt(lastUsage?["totalTokens"]) ?? 0,
            contextWindow: contextWindow,
            costUsd: 0
          ),
          turnId: turnId ?? optionalString(usageDict["turnId"]) ?? "",
          itemId: nil
        )
      case "codex_turn_stalled":
        event = .codexTurnStalled(
          message: stringValue(eventDict["message"]),
          recoveryOptions: eventDict["recoveryOptions"] as? [String] ?? [],
          turnId: turnId,
          sourceSessionId: optionalString(eventDict["sourceSessionId"])
        )
      case "completion_report":
        let report = eventDict["report"] as? [String: Any] ?? [:]
        let artifacts = (report["artifacts"] as? [[String: Any]] ?? []).map { artifact in
          WorkCompletionArtifactModel(
            type: stringValue(artifact["type"]),
            description: stringValue(artifact["description"]),
            reference: optionalString(artifact["reference"])
          )
        }
        event = .completionReport(
          summary: stringValue(report["summary"]),
          status: stringValue(report["status"]),
          artifacts: artifacts,
          blockerDescription: optionalString(report["blockerDescription"]),
          turnId: turnId
        )
      case "prompt_suggestion":
        event = .promptSuggestion(text: stringValue(eventDict["suggestion"]), turnId: turnId)
      case "context_compact":
        let isInProgress = optionalString(eventDict["state"]) == "started"
        event = .contextCompact(
          summary: workContextCompactSummary(from: eventDict),
          isInProgress: isInProgress,
          turnId: turnId,
          compactionId: workContextCompactMergeId(from: eventDict, turnId: turnId)
        )
      case "codex_context_compaction":
        let isInProgress = optionalString(eventDict["state"]) == "started"
        event = .contextCompact(
          summary: workContextCompactSummary(from: eventDict),
          isInProgress: isInProgress,
          turnId: turnId,
          compactionId: workContextCompactMergeId(from: eventDict, turnId: turnId)
        )
      case "auto_approval_review":
        let action = optionalString(eventDict["action"])
        let review = optionalString(eventDict["review"])
        let status = stringValue(eventDict["reviewStatus"]).replacingOccurrences(of: "_", with: " ").capitalized
        event = .autoApprovalReview(summary: [status, action, review].compactMap { $0 }.joined(separator: "\n"), turnId: turnId)
      case "web_search":
        event = .webSearch(
          query: stringValue(eventDict["query"]),
          action: optionalString(eventDict["action"]),
          actions: parseCodexWebSearchActions(from: eventDict["actions"]),
          status: toolStatus(from: stringValue(eventDict["status"])),
          itemId: stableToolItemId ?? workFallbackItemID(
            sessionId: sessionId,
            timestamp: timestamp,
            sequence: sequence,
            type: type,
            seed: [
              "web_search",
              turnId ?? "",
              stringValue(eventDict["query"]),
              optionalString(eventDict["action"]) ?? "",
              stringValue(eventDict["status"]),
            ].joined(separator: "|")
          ),
          turnId: turnId
        )
      case "codex_image_generation", "image_generation":
        event = workCodexImageGenerationEvent(
          itemId: itemId ?? workFallbackItemID(
            sessionId: sessionId,
            timestamp: timestamp,
            sequence: sequence,
            type: type,
            seed: ["image_generation", turnId ?? "", optionalString(eventDict["prompt"]) ?? ""].joined(separator: "|")
          ),
          turnId: turnId,
          prompt: optionalString(eventDict["prompt"]),
          revisedPrompt: optionalString(eventDict["revisedPrompt"] ?? eventDict["revised_prompt"]),
          result: optionalString(eventDict["result"]),
          savedPath: optionalString(eventDict["savedPath"] ?? eventDict["saved_path"]),
          resultOriginalBytes: optionalWorkInt(eventDict["resultOriginalBytes"] ?? eventDict["result_original_bytes"]),
          resultOmittedBytes: optionalWorkInt(eventDict["resultOmittedBytes"] ?? eventDict["result_omitted_bytes"]),
          status: stringValue(eventDict["status"])
        )
      case "codex_image_view", "image_view":
        event = workCodexImageViewEvent(
          itemId: itemId ?? workFallbackItemID(
            sessionId: sessionId,
            timestamp: timestamp,
            sequence: sequence,
            type: type,
            seed: ["image_view", turnId ?? "", optionalString(eventDict["path"]) ?? "", optionalString(eventDict["url"]) ?? ""].joined(separator: "|")
          ),
          turnId: turnId,
          path: optionalString(eventDict["path"]),
          url: optionalString(eventDict["url"]),
          title: optionalString(eventDict["title"]),
          urlOriginalBytes: optionalWorkInt(eventDict["urlOriginalBytes"] ?? eventDict["url_original_bytes"]),
          urlOmittedBytes: optionalWorkInt(eventDict["urlOmittedBytes"] ?? eventDict["url_omitted_bytes"]),
          status: stringValue(eventDict["status"])
        )
      case "plan_text":
        event = .planText(text: stringValue(eventDict["text"]), turnId: turnId)
      case "tool_use_summary":
        event = .toolUseSummary(text: stringValue(eventDict["summary"]), turnId: turnId)
      case "command":
        event = .command(
          command: stringValue(eventDict["command"]),
          cwd: stringValue(eventDict["cwd"]),
          output: stringValue(eventDict["output"]),
          status: toolStatus(from: stringValue(eventDict["status"])),
          itemId: stableToolItemId ?? workFallbackItemID(
            sessionId: sessionId,
            timestamp: timestamp,
            sequence: sequence,
            type: type,
            seed: [
              "command",
              turnId ?? "",
              stringValue(eventDict["command"]),
              stringValue(eventDict["cwd"]),
              stringValue(eventDict["output"]),
              stringValue(eventDict["status"]),
            ].joined(separator: "|")
          ),
          exitCode: eventDict["exitCode"] as? Int,
          durationMs: eventDict["durationMs"] as? Int,
          turnId: turnId
        )
      case "file_change":
        // Keep raw `itemId` here — the desktop emitter produces one event per
        // file with a shared `logicalItemId`, so collapsing would overwrite
        // earlier paths in `buildWorkFileChangeCards`.
        event = .fileChange(
          path: stringValue(eventDict["path"]),
          diff: stringValue(eventDict["diff"]),
          kind: stringValue(eventDict["kind"]),
          status: toolStatus(from: stringValue(eventDict["status"])),
          itemId: itemId ?? workFallbackItemID(
            sessionId: sessionId,
            timestamp: timestamp,
            sequence: sequence,
            type: type,
            seed: [
              "file_change",
              turnId ?? "",
              stringValue(eventDict["path"]),
              stringValue(eventDict["kind"]),
              stringValue(eventDict["diff"]),
              stringValue(eventDict["status"]),
            ].joined(separator: "|")
          ),
          turnId: turnId
        )
      default:
        event = .unknown(type: type)
      }

      return WorkChatEnvelope(
        sessionId: sessionId,
        timestamp: timestamp,
        sequence: sequence,
        event: event,
        subagentTaskType: subagentTaskType,
        subagentCommand: subagentCommand
      )
    }
    .sorted { lhs, rhs in
      if lhs.timestamp == rhs.timestamp {
        return (lhs.sequence ?? 0) < (rhs.sequence ?? 0)
      }
      return lhs.timestamp < rhs.timestamp
    }
}

private func parseAgentChatFileRefs(from value: Any?) -> [AgentChatFileRef]? {
  guard let array = value as? [[String: Any]], !array.isEmpty else { return nil }
  let refs = array.compactMap { dict -> AgentChatFileRef? in
    guard let path = optionalString(dict["path"]), !path.isEmpty else { return nil }
    let type = optionalString(dict["type"]) ?? "file"
    return AgentChatFileRef(path: path, type: type, url: optionalString(dict["url"]))
  }
  return refs.isEmpty ? nil : refs
}

private func userMessageDisplayText(from eventDict: [String: Any]) -> String {
  if let displayText = optionalString(eventDict["displayText"])?.trimmingCharacters(in: .whitespacesAndNewlines),
     !displayText.isEmpty {
    return displayText
  }
  return stringValue(eventDict["text"])
}

func extractLooseJSONObjects(from raw: String) -> [String] {
  var objects: [String] = []
  var buffer = ""
  var depth = 0
  var insideString = false
  var escaping = false

  for character in raw {
    if depth == 0 {
      guard character == "{" else { continue }
      depth = 1
      buffer = "{" 
      insideString = false
      escaping = false
      continue
    }

    buffer.append(character)

    if insideString {
      if escaping {
        escaping = false
      } else if character == "\\" {
        escaping = true
      } else if character == "\"" {
        insideString = false
      }
      continue
    }

    if character == "\"" {
      insideString = true
    } else if character == "{" {
      depth += 1
    } else if character == "}" {
      depth -= 1
      if depth == 0 {
        objects.append(buffer)
        buffer = ""
      }
    }
  }

  return objects
}

func sanitizeLooseJSONControlCharacters(in raw: String) -> String {
  var sanitized = ""
  var insideString = false
  var escaping = false

  for character in raw {
    if insideString {
      if escaping {
        sanitized.append(character)
        escaping = false
        continue
      }

      switch character {
      case "\\":
        sanitized.append(character)
        escaping = true
      case "\"":
        sanitized.append(character)
        insideString = false
      case "\n":
        sanitized.append("\\n")
      case "\r":
        sanitized.append("\\r")
      case "\t":
        sanitized.append("\\t")
      default:
        if let scalar = character.unicodeScalars.first, scalar.value < 0x20 {
          sanitized.append(String(format: "\\u%04X", scalar.value))
        } else {
          sanitized.append(character)
        }
      }
      continue
    }

    sanitized.append(character)
    if character == "\"" {
      insideString = true
    }
  }

  return sanitized
}
