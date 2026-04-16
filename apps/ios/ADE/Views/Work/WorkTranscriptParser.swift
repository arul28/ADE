import SwiftUI
import UIKit
import AVKit

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
      let parentItemId = eventDict["parentItemId"] as? String
      let event: WorkChatEvent

      switch type {
      case "user_message":
        event = .userMessage(
          text: stringValue(eventDict["text"]),
          turnId: turnId,
          steerId: optionalString(eventDict["steerId"]),
          deliveryState: optionalString(eventDict["deliveryState"]),
          processed: eventDict["processed"] as? Bool
        )
      case "text":
        event = .assistantText(text: stringValue(eventDict["text"]), turnId: turnId, itemId: itemId)
      case "tool_call":
        event = .toolCall(
          tool: stringValue(eventDict["tool"]),
          argsText: prettyPrintedJSONString(eventDict["args"]),
          itemId: itemId ?? UUID().uuidString,
          parentItemId: parentItemId,
          turnId: turnId
        )
      case "tool_result":
        event = .toolResult(
          tool: stringValue(eventDict["tool"]),
          resultText: prettyPrintedJSONString(eventDict["result"]),
          itemId: itemId ?? UUID().uuidString,
          parentItemId: parentItemId,
          turnId: turnId,
          status: toolStatus(from: stringValue(eventDict["status"]))
        )
      case "activity":
        event = .activity(kind: stringValue(eventDict["activity"]), detail: optionalString(eventDict["detail"]), turnId: turnId)
      case "plan":
        let steps = (eventDict["steps"] as? [[String: Any]] ?? []).map { step in
          let status = stringValue(step["status"]).replacingOccurrences(of: "_", with: " ").capitalized
          let description = stringValue(step["description"])
          return description.isEmpty ? status : "\(status): \(description)"
        }
        event = .plan(steps: steps, explanation: optionalString(eventDict["explanation"]), turnId: turnId)
      case "subagent_started":
        event = .subagentStarted(
          taskId: stringValue(eventDict["taskId"]),
          description: stringValue(eventDict["description"]),
          background: (eventDict["background"] as? Bool) ?? false,
          turnId: turnId
        )
      case "subagent_progress":
        event = .subagentProgress(
          taskId: stringValue(eventDict["taskId"]),
          description: optionalString(eventDict["description"]),
          summary: stringValue(eventDict["summary"]),
          toolName: optionalString(eventDict["lastToolName"]),
          turnId: turnId
        )
      case "subagent_result":
        event = .subagentResult(
          taskId: stringValue(eventDict["taskId"]),
          status: stringValue(eventDict["status"]),
          summary: stringValue(eventDict["summary"]),
          turnId: turnId
        )
      case "status":
        event = .status(turnStatus: stringValue(eventDict["turnStatus"]), message: optionalString(eventDict["message"]), turnId: turnId)
      case "reasoning":
        event = .reasoning(text: stringValue(eventDict["text"]), turnId: turnId)
      case "approval_request":
        event = .approvalRequest(
          description: stringValue(eventDict["description"]),
          detail: optionalString(prettyPrintedJSONString(eventDict["detail"])),
          itemId: itemId ?? UUID().uuidString,
          turnId: turnId
        )
      case "pending_input_resolved":
        event = .pendingInputResolved(
          itemId: itemId ?? UUID().uuidString,
          resolution: stringValue(eventDict["resolution"]),
          turnId: turnId
        )
      case "structured_question":
        let options = (eventDict["options"] as? [[String: Any]] ?? []).compactMap { optionalString($0["label"]) ?? optionalString($0["value"]) }
        event = .structuredQuestion(
          question: stringValue(eventDict["question"]),
          options: options,
          itemId: itemId ?? UUID().uuidString,
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
        let detailText = optionalString(prettyPrintedJSONString(eventDict["errorInfo"]))
        event = .error(
          message: stringValue(eventDict["message"]),
          detail: detailText,
          category: workErrorCategory(message: stringValue(eventDict["message"]), detail: detailText),
          turnId: turnId
        )
      case "done":
        let usage = prettyPrintedJSONString(eventDict["usage"])
        let cost = eventDict["costUsd"] as? NSNumber
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
          inputTokens: eventDict["usage"].flatMap { value in
            (value as? [String: Any])?["inputTokens"] as? Int
          },
          outputTokens: eventDict["usage"].flatMap { value in
            (value as? [String: Any])?["outputTokens"] as? Int
          },
          cacheReadTokens: eventDict["usage"].flatMap { value in
            (value as? [String: Any])?["cacheReadTokens"] as? Int
          },
          cacheCreationTokens: eventDict["usage"].flatMap { value in
            (value as? [String: Any])?["cacheCreationTokens"] as? Int
          },
          costUsd: cost?.doubleValue
        )
        event = .done(
          status: stringValue(eventDict["status"]),
          summary: summaryParts.joined(separator: "\n"),
          usage: usageSummary,
          turnId: stringValue(eventDict["turnId"])
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
        let trigger = stringValue(eventDict["trigger"]).replacingOccurrences(of: "_", with: " ").capitalized
        let preTokens = optionalString(eventDict["preTokens"])
        event = .contextCompact(summary: [trigger, preTokens.map { "Pre-compact tokens: \($0)" }].compactMap { $0 }.joined(separator: "\n"), turnId: turnId)
      case "auto_approval_review":
        let action = optionalString(eventDict["action"])
        let review = optionalString(eventDict["review"])
        let status = stringValue(eventDict["reviewStatus"]).replacingOccurrences(of: "_", with: " ").capitalized
        event = .autoApprovalReview(summary: [status, action, review].compactMap { $0 }.joined(separator: "\n"), turnId: turnId)
      case "web_search":
        event = .webSearch(
          query: stringValue(eventDict["query"]),
          action: optionalString(eventDict["action"]),
          status: toolStatus(from: stringValue(eventDict["status"])),
          itemId: itemId ?? UUID().uuidString,
          turnId: turnId
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
          itemId: itemId ?? UUID().uuidString,
          exitCode: eventDict["exitCode"] as? Int,
          durationMs: eventDict["durationMs"] as? Int,
          turnId: turnId
        )
      case "file_change":
        event = .fileChange(
          path: stringValue(eventDict["path"]),
          diff: stringValue(eventDict["diff"]),
          kind: stringValue(eventDict["kind"]),
          status: toolStatus(from: stringValue(eventDict["status"])),
          itemId: itemId ?? UUID().uuidString,
          turnId: turnId
        )
      default:
        event = .unknown(type: type)
      }

      return WorkChatEnvelope(sessionId: sessionId, timestamp: timestamp, sequence: sequence, event: event)
    }
    .sorted { lhs, rhs in
      if lhs.timestamp == rhs.timestamp {
        return (lhs.sequence ?? 0) < (rhs.sequence ?? 0)
      }
      return lhs.timestamp < rhs.timestamp
    }
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
        sanitized.append(character)
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
