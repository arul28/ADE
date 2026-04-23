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
  let metadataByTurn = workTurnModelMetadataByTurn(from: transcript)
  // Tracks whether the previous envelope was assistantText so nil-itemId
  // streaming fragments can merge into it. MUST be reset to false on every
  // non-assistantText branch below — otherwise a subsequent nil-itemId
  // fragment could wrongly merge across an intervening tool call or user
  // message. Any new `WorkChatEvent` case added here must preserve that reset.
  var previousEnvelopeWasAssistantText = false

  for envelope in transcript {
    switch envelope.event {
    case .userMessage(let text, let turnId, let steerId, let deliveryState, let processed):
      previousEnvelopeWasAssistantText = false
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
      let metadata = turnId
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .flatMap { metadataByTurn[$0] }
      let canMergeWithPreviousAssistant = itemId != nil || previousEnvelopeWasAssistantText
      if let lastIndex = messages.indices.last,
         messages[lastIndex].role == "assistant",
         messages[lastIndex].turnId == turnId,
         messages[lastIndex].itemId == itemId,
         canMergeWithPreviousAssistant {
        messages[lastIndex].markdown = mergeWorkStreamingText(messages[lastIndex].markdown, text)
      } else {
        messages.append(WorkChatMessage(
          id: envelope.id,
          role: "assistant",
          markdown: text,
          timestamp: envelope.timestamp,
          turnId: turnId,
          itemId: itemId,
          turnProvider: metadata?.provider,
          turnModelId: metadata?.modelId
        ))
      }
      previousEnvelopeWasAssistantText = true
    default:
      previousEnvelopeWasAssistantText = false
      continue
    }
  }

  return messages
}

func mergeWorkStreamingText(_ existing: String, _ incoming: String) -> String {
  if existing.isEmpty { return incoming }
  if incoming.isEmpty { return existing }
  if existing == incoming { return existing }
  if incoming.hasPrefix(existing) { return incoming }
  if existing.hasPrefix(incoming) { return existing }

  let maxOverlap = min(existing.count, incoming.count)
  guard maxOverlap > 0 else { return existing + incoming }

  for length in stride(from: maxOverlap, through: 1, by: -1) {
    let existingSuffix = existing.suffix(length)
    let incomingPrefix = incoming.prefix(length)
    if existingSuffix == incomingPrefix {
      return existing + incoming.dropFirst(length)
    }
  }

  return existing + incoming
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

func isFallbackOnlyWorkTranscript(_ transcript: [WorkChatEnvelope]) -> Bool {
  guard !transcript.isEmpty else { return false }
  return transcript.allSatisfy { envelope in
    guard envelope.sequence == nil else { return false }
    switch envelope.event {
    case .userMessage:
      return true
    case .assistantText(_, _, let itemId):
      return itemId == nil
    default:
      return false
    }
  }
}

func preferredWorkTranscript(
  current: [WorkChatEnvelope],
  fallback: [WorkChatEnvelope],
  eventTranscript: [WorkChatEnvelope]
) -> [WorkChatEnvelope] {
  if !eventTranscript.isEmpty {
    let base = isFallbackOnlyWorkTranscript(current) ? [] : current
    let merged = mergeWorkChatTranscripts(base: base, live: eventTranscript)
    // The live event stream may be missing tail envelopes after a disconnect
    // or when the host didn't replay the full snapshot on re-subscribe. The
    // `chat.getTranscript` fallback always contains the canonical user /
    // assistant text history, so splice in any text envelopes that didn't
    // make it into the live stream (compared by role+turnId+text). Without
    // this, the final assistant reply after e.g. a plan rejection vanishes
    // from mobile while it still shows on desktop.
    return backfillMissingTextEnvelopes(into: merged, fallback: fallback)
  }
  if !fallback.isEmpty {
    return fallback
  }
  return current
}

private func backfillMissingTextEnvelopes(
  into transcript: [WorkChatEnvelope],
  fallback: [WorkChatEnvelope]
) -> [WorkChatEnvelope] {
  guard !fallback.isEmpty else { return transcript }
  var seen: Set<String> = []
  for envelope in transcript {
    if let key = workTextContentKey(for: envelope) {
      seen.insert(key)
    }
  }
  var missing: [WorkChatEnvelope] = []
  for envelope in fallback {
    guard let key = workTextContentKey(for: envelope), !seen.contains(key) else { continue }
    seen.insert(key)
    missing.append(envelope)
  }
  guard !missing.isEmpty else { return transcript }
  var merged = transcript
  merged.append(contentsOf: missing)
  return merged.sorted { lhs, rhs in
    if lhs.timestamp == rhs.timestamp {
      return (lhs.sequence ?? 0) < (rhs.sequence ?? 0)
    }
    return lhs.timestamp < rhs.timestamp
  }
}

/// Identity key for a user/assistant text envelope used for backfill dedup.
/// Fallback entries set `itemId: nil`, live envelopes carry an SDK-assigned
/// id — so plain equality on merge keys would treat "same message, different
/// source" as two rows. Keying on role + turnId + normalized text collapses
/// those correctly while leaving tool-calls and other events untouched
/// (returns nil → skipped).
private func workTextContentKey(for envelope: WorkChatEnvelope) -> String? {
  switch envelope.event {
  case .userMessage(let text, let turnId, let steerId, _, _):
    let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return "user|\(turnId ?? "")|\(steerId ?? "")|\(normalized)"
  case .assistantText(let text, let turnId, _):
    let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return "assistant|\(turnId ?? "")|\(normalized)"
  default:
    return nil
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
  case permission(WorkPendingPermissionModel)
  /// Plan-approval gate — agent finished planning and is waiting for
  /// Approve & Implement or Reject & Revise before acting.
  case planApproval(WorkPendingPlanApprovalModel)

  var id: String {
    switch self {
    case .approval(let model): return "approval:\(model.id)"
    case .question(let model): return "question:\(model.id)"
    case .permission(let model): return "permission:\(model.id)"
    case .planApproval(let model): return "plan-approval:\(model.id)"
    }
  }

  var itemId: String {
    switch self {
    case .approval(let model): return model.id
    case .question(let model): return model.id
    case .permission(let model): return model.id
    case .planApproval(let model): return model.id
    }
  }
}

struct WorkPendingSteerModel: Identifiable, Equatable {
  let id: String
  var text: String
  let turnId: String?
  let timestamp: String
}

func workJSONObject(from text: String?) -> [String: Any]? {
  guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines),
        !text.isEmpty,
        let data = text.data(using: .utf8),
        let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
  else {
    return nil
  }
  return object
}

func workBoolValue(_ value: Any?) -> Bool? {
  if let bool = value as? Bool {
    return bool
  }
  if let number = value as? NSNumber {
    return number.boolValue
  }
  if let string = value as? String {
    switch string.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
    case "true", "1", "yes": return true
    case "false", "0", "no": return false
    default: return nil
    }
  }
  return nil
}

func workPendingQuestionOption(from value: Any?) -> WorkPendingQuestionOption? {
  guard let object = value as? [String: Any] else { return nil }
  let label = optionalString(object["label"]) ?? optionalString(object["value"]) ?? ""
  let rawValue = optionalString(object["value"]) ?? label
  guard !label.isEmpty, !rawValue.isEmpty else { return nil }
  return WorkPendingQuestionOption(
    label: label,
    value: rawValue,
    description: optionalString(object["description"]),
    recommended: workBoolValue(object["recommended"]) ?? false,
    preview: optionalString(object["preview"]),
    previewFormat: optionalString(object["previewFormat"])
  )
}

/// Map a single question dictionary (one entry in the request's `questions` array,
/// or a flat ask_user tool-call args blob) into the structured question model.
/// Falls back onto outer scope (`request` / args root) for flags/metadata so the
/// parent card retains legacy single-question behavior.
func workPendingQuestionEntry(
  from object: [String: Any],
  fallback: [String: Any],
  index: Int,
  fallbackQuestionText: String? = nil
) -> WorkPendingQuestion {
  let questionId = optionalString(object["id"])
    ?? optionalString(fallback["id"])
    ?? (index == 0 ? "response" : "response-\(index)")
  let questionText = optionalString(object["question"])
    ?? optionalString(fallback["description"])
    ?? optionalString(fallback["title"])
    ?? fallbackQuestionText
    ?? ""
  let header = optionalString(object["header"]) ?? optionalString(object["label"])
  let rawOptions = (object["options"] as? [Any]) ?? (fallback["options"] as? [Any]) ?? []
  let options = rawOptions.compactMap { workPendingQuestionOption(from: $0) }
  let allowsFreeform = workBoolValue(object["allowsFreeform"])
    ?? workBoolValue(fallback["allowsFreeform"])
    ?? options.isEmpty
  let multiSelect = workBoolValue(object["multiSelect"])
    ?? workBoolValue(fallback["multiSelect"])
    ?? false
  let isSecret = workBoolValue(object["isSecret"])
    ?? workBoolValue(fallback["isSecret"])
    ?? false
  let defaultAssumption = optionalString(object["defaultAssumption"])
    ?? optionalString(fallback["defaultAssumption"])
  let impact = optionalString(object["impact"]) ?? optionalString(fallback["impact"])
  return WorkPendingQuestion(
    questionId: questionId,
    question: questionText,
    options: options,
    allowsFreeform: allowsFreeform,
    header: header,
    defaultAssumption: defaultAssumption,
    impact: impact,
    multiSelect: multiSelect,
    isSecret: isSecret
  )
}

func pendingWorkQuestionFromApproval(
  description: String,
  detail: String?,
  itemId: String
) -> WorkPendingQuestionModel? {
  guard let detailObject = workJSONObject(from: detail) else { return nil }
  if let request = detailObject["request"] as? [String: Any] {
    let kind = optionalString(request["kind"])?.lowercased() ?? ""
    let rawQuestions = request["questions"] as? [[String: Any]] ?? []
    guard kind == "question" || kind == "structured_question" || !rawQuestions.isEmpty else {
      return nil
    }
    let source: [[String: Any]] = rawQuestions.isEmpty ? [[:]] : rawQuestions
    let questions = source.enumerated().map { index, raw in
      workPendingQuestionEntry(
        from: raw,
        fallback: request,
        index: index,
        fallbackQuestionText: description
      )
    }
    return WorkPendingQuestionModel(
      id: itemId,
      questions: questions,
      title: optionalString(request["title"]),
      body: optionalString(request["body"]) ?? optionalString(request["description"])
    )
  }

  let request = detailObject["request"] as? [String: Any] ?? [:]
  let tool = optionalString(detailObject["tool"])
    ?? optionalString(request["tool"])
    ?? optionalString(request["toolName"])
    ?? ""
  let questionText = optionalString(detailObject["question"]) ?? description
  guard isQuestionInputToolName(tool), !questionText.isEmpty else {
    return nil
  }
  let options = (detailObject["options"] as? [Any] ?? [])
    .compactMap { workPendingQuestionOption(from: $0) }
  let single = WorkPendingQuestion(
    questionId: "response",
    question: questionText,
    options: options,
    allowsFreeform: true,
    defaultAssumption: optionalString(detailObject["defaultAssumption"]),
    impact: optionalString(detailObject["impact"]),
    multiSelect: workBoolValue(detailObject["multiSelect"]) ?? false,
    isSecret: workBoolValue(detailObject["isSecret"]) ?? false
  )
  return WorkPendingQuestionModel(
    id: itemId,
    questions: [single],
    title: optionalString(detailObject["title"]),
    body: optionalString(detailObject["body"]) ?? optionalString(detailObject["description"])
  )
}

/// Fallback parser for ask_user invocations that arrive as raw `tool_call` envelopes
/// without a wrapping `approval_request`. Returns nil unless the call is still pending
/// (no matching tool_result yet).
func pendingWorkQuestionFromAskUserToolCall(
  argsText: String,
  itemId: String
) -> WorkPendingQuestionModel? {
  guard let object = workJSONObject(from: argsText) else { return nil }
  // Modern protocol payloads can wrap ask input under a `request` object
  // (same shape as desktop approval detail), so read both legacy flat shape
  // and the nested shape used by current request handlers.
  let request = object["request"] as? [String: Any] ?? [:]
  let sourceObject = !request.isEmpty ? request : object
  let rawQuestions = sourceObject["questions"] as? [[String: Any]] ?? []
  let source: [[String: Any]] = rawQuestions.isEmpty ? [sourceObject] : rawQuestions
  let fallbackQuestionText =
    optionalString(sourceObject["question"])
    ?? optionalString(object["question"])
    ?? optionalString(object["title"])
    ?? optionalString(request["description"])
  // The raw-args legacy shape needs a question string to be valid at all.
  if rawQuestions.isEmpty, fallbackQuestionText == nil { return nil }
  let questions = source.enumerated().map { index, raw in
    workPendingQuestionEntry(
      from: raw,
      fallback: request.isEmpty ? object : sourceObject,
      index: index,
      fallbackQuestionText: fallbackQuestionText
    )
  }
  guard questions.contains(where: { !$0.question.isEmpty }) else { return nil }
  return WorkPendingQuestionModel(
    id: itemId,
    questions: questions,
    title: optionalString(sourceObject["title"]) ?? optionalString(object["title"]),
    body: optionalString(sourceObject["body"]) ?? optionalString(request["description"]) ?? optionalString(object["body"])
  )
}

/// When `pendingWorkQuestionFromApproval` returns nil for an approval, check whether
/// it's a generic MCP permission gate (other than auto-allowed `ask_user`) that the
/// UI should surface as an Allow / Allow-for-session / Decline card.
func pendingWorkPermissionFromApproval(
  description: String,
  detail: String?,
  itemId: String
) -> WorkPendingPermissionModel? {
  guard let detailObject = workJSONObject(from: detail) else { return nil }
  let request = detailObject["request"] as? [String: Any] ?? detailObject
  let kind = optionalString(request["kind"])?.lowercased() ?? ""
  guard kind == "permissions" || kind == "permission" else { return nil }
  let tool = optionalString(request["tool"])
    ?? optionalString(request["toolName"])
    ?? optionalString(detailObject["tool"])
    ?? ""
  // Question tools should be routed through the structured-question path. If one
  // slips through this branch, avoid double-rendering a redundant permission card.
  if isQuestionInputToolName(tool) {
    return nil
  }
  return WorkPendingPermissionModel(
    id: itemId,
    tool: tool.isEmpty ? "tool" : tool,
    description: description,
    detail: optionalString(request["description"]) ?? optionalString(detailObject["description"])
  )
}

/// Parse an `approval_request` detail blob whose `request.kind == "plan_approval"` into the
/// dedicated plan-approval model. Returns nil for anything that isn't a plan-approval gate.
func pendingWorkPlanApprovalFromApproval(
  description: String,
  detail: String?,
  itemId: String
) -> WorkPendingPlanApprovalModel? {
  // The plan text lives in one of several places depending on the provider:
  //   detail.request.kind == "plan_approval"
  //   detail.request.description or detail.request.questions[0].question (plan body)
  //   detail.planContent (raw plan text emitted by the codex path)
  guard let detailObject = workJSONObject(from: detail) else {
    return nil
  }
  let request = detailObject["request"] as? [String: Any] ?? [:]
  let kind = (optionalString(request["kind"]) ?? "").lowercased()
  guard kind == "plan_approval" else { return nil }
  let source = optionalString(request["source"])
    ?? optionalString(detailObject["tool"])?.lowercased() ?? ""
  let planText: String = {
    // Prefer the plan text from providerMetadata.planContent, then the
    // question text, then the description field, then fall back to the
    // outer approval_request description so the card always has something
    // to show.
    if let meta = request["providerMetadata"] as? [String: Any],
       let content = optionalString(meta["planContent"] ?? meta["plan"]) {
      return content
    }
    if let questions = request["questions"] as? [[String: Any]],
       let firstQuestion = questions.first,
       let q = optionalString(firstQuestion["question"]) {
      return q
    }
    if let reqDesc = optionalString(request["description"]) {
      return reqDesc
    }
    if let planContent = optionalString(detailObject["planContent"]) {
      return planContent
    }
    return description
  }()
  let title = optionalString(request["title"]) ?? "Plan Ready for Review"
  return WorkPendingPlanApprovalModel(
    id: itemId,
    source: source,
    planText: planText,
    title: title
  )
}

/// Ordered list of still-open pending inputs (approvals + structured questions + permission
/// gates) in the order they were requested. Mirrors the desktop `derivePendingInputRequests`
/// helper — resolved items are filtered out using the same predicate as `pendingWorkInputItemIds`.
func derivePendingWorkInputs(from transcript: [WorkChatEnvelope]) -> [WorkPendingInputItem] {
  let openIds = pendingWorkInputItemIds(from: transcript)
  var seen = Set<String>()
  var results: [WorkPendingInputItem] = []
  for envelope in sortedWorkChatEnvelopes(transcript) {
    switch envelope.event {
    case .approvalRequest(let description, let detail, let itemId, _):
      guard openIds.contains(itemId), !seen.contains(itemId) else { continue }
      seen.insert(itemId)
      if let planApproval = pendingWorkPlanApprovalFromApproval(description: description, detail: detail, itemId: itemId) {
        results.append(.planApproval(planApproval))
      } else if let question = pendingWorkQuestionFromApproval(description: description, detail: detail, itemId: itemId) {
        results.append(.question(question))
      } else if let permission = pendingWorkPermissionFromApproval(description: description, detail: detail, itemId: itemId) {
        results.append(.permission(permission))
      } else {
        results.append(.approval(WorkPendingApprovalModel(id: itemId, description: description, detail: detail)))
      }
    case .structuredQuestion(let question, let options, let itemId, _):
      guard openIds.contains(itemId), !seen.contains(itemId) else { continue }
      seen.insert(itemId)
      let entry = WorkPendingQuestion(
        questionId: "response",
        question: question,
        options: options,
        allowsFreeform: true
      )
      results.append(.question(WorkPendingQuestionModel(id: itemId, questions: [entry])))
    case .toolCall(let tool, let argsText, let itemId, _, _):
      guard openIds.contains(itemId), !seen.contains(itemId) else { continue }
      guard isQuestionInputToolName(tool) else { continue }
      guard let question = pendingWorkQuestionFromAskUserToolCall(argsText: argsText, itemId: itemId) else { continue }
      seen.insert(itemId)
      results.append(.question(question))
    default:
      continue
    }
  }
  return results
}

func isAskUserToolName(_ tool: String) -> Bool {
  let normalized = normalizedWorkToolIdentity(tool)
  return normalized == "ask_user" || normalized == "askuser" || normalized == "mcp_ade_ask_user"
}

func isRequestUserInputToolName(_ tool: String) -> Bool {
  let normalized = normalizedWorkToolIdentity(tool)
  return normalized == "request_user_input"
    || normalized == "requestuserinput"
    || normalized == "mcp_ade_request_user_input"
}

func isQuestionInputToolName(_ tool: String) -> Bool {
  isAskUserToolName(tool) || isRequestUserInputToolName(tool)
}

private func normalizedWorkToolIdentity(_ tool: String) -> String {
  tool
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .lowercased()
    .replacingOccurrences(of: "-", with: "_")
    .replacingOccurrences(of: #"_+"#, with: "_", options: .regularExpression)
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
    case .approvalRequest(let description, let detail, let itemId, let turnId):
      if pendingWorkQuestionFromApproval(description: description, detail: detail, itemId: itemId) != nil {
        questions.updateValue(turnId, forKey: itemId)
      } else {
        approvals.updateValue(turnId, forKey: itemId)
      }
    case .structuredQuestion(_, _, let itemId, let turnId):
      questions.updateValue(turnId, forKey: itemId)
    case .toolCall(let tool, let argsText, let itemId, _, let turnId):
      if isQuestionInputToolName(tool),
         pendingWorkQuestionFromAskUserToolCall(argsText: argsText, itemId: itemId) != nil {
        questions.updateValue(turnId, forKey: itemId)
      }
    case .pendingInputResolved(let itemId, _, _):
      approvals.removeValue(forKey: itemId)
      questions.removeValue(forKey: itemId)
    case .toolResult(_, _, let itemId, _, _, _),
         .command(_, _, _, _, let itemId, _, _, _),
         .fileChange(_, _, _, _, let itemId, _):
      approvals.removeValue(forKey: itemId)
      questions.removeValue(forKey: itemId)
    case .done(let status, _, _, let turnId, _, _):
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
    let digest = options.map { "\($0.label)\t\($0.value)\t\($0.description ?? "")\t\($0.recommended ? "1" : "0")" }.joined(separator: "\n")
    return ["structured_question", turnId ?? "", itemId, question, digest].joined(separator: "|")
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
  case .done(let status, let summary, let usage, let turnId, let model, let modelId):
    return ["done", turnId, status, model ?? "", modelId ?? "", summary, workUsageSummaryMergeKey(usage)].joined(separator: "|")
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
  case .reasoning(let text, let turnId, let itemId, let summaryIndex):
    return ["reasoning", turnId ?? "", itemId ?? "", summaryIndex.map(String.init) ?? "", text].joined(separator: "|")
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
