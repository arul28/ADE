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
  let suppressedItemIds = Set(pendingInputs.map(\.itemId))
  let suppressedToolItemIds = Set(pendingInputs.map(\.itemId))
  let toolCards = buildWorkToolCards(from: transcript, suppressedPendingItemIds: suppressedToolItemIds)
  let eventCards = buildWorkEventCards(from: transcript, suppressedItemIds: suppressedItemIds)
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
    pendingInputs: pendingInputs,
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

  // Resolve a chronological timestamp for each pending-input itemId by looking
  // up its originating approval_request / structured_question / question-tool
  // tool_call envelope. Falling back to the latest transcript timestamp keeps
  // the pending card in place when the source envelope was dropped upstream.
  let pendingTimestamps = workPendingInputTimestamps(from: transcript)
  let fallbackPendingTimestamp = transcript.last?.timestamp ?? ""
  entries.append(contentsOf: pendingInputs.enumerated().compactMap { index, input -> WorkTimelineEntry? in
    switch input {
    case .question(let model):
      let ts = pendingTimestamps[model.id] ?? fallbackPendingTimestamp
      return WorkTimelineEntry(
        id: "pending-question-\(model.id)",
        timestamp: ts,
        rank: 1_600 + index,
        payload: .pendingQuestion(model)
      )
    case .permission(let model):
      let ts = pendingTimestamps[model.id] ?? fallbackPendingTimestamp
      return WorkTimelineEntry(
        id: "pending-permission-\(model.id)",
        timestamp: ts,
        rank: 1_600 + index,
        payload: .pendingPermission(model)
      )
    case .planApproval(let model):
      let ts = pendingTimestamps[model.id] ?? fallbackPendingTimestamp
      return WorkTimelineEntry(
        id: "pending-plan-approval-\(model.id)",
        timestamp: ts,
        rank: 1_600 + index,
        payload: .pendingPlanApproval(model)
      )
    case .approval:
      return nil
    }
  })

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

  entries.append(contentsOf: artifacts.enumerated().map { index, artifact in
    WorkTimelineEntry(id: "artifact-\(artifact.id)", timestamp: artifact.createdAt, rank: 2_000 + index, payload: .artifact(artifact))
  })

  entries.append(contentsOf: visibleLocalEchoMessages.enumerated().map { index, echo in
    let message = WorkChatMessage(id: echo.id, role: "user", markdown: echo.text, timestamp: echo.timestamp, turnId: nil, itemId: nil)
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
  return collapseConsecutiveWorkToolEntries(deduped)
}

/// Fold tool-like timeline entries (tool cards, commands, file changes) into
/// a single `.toolGroup` entry so the iOS chat mirrors the desktop
/// `work_log_group` behavior — one summary row per cluster instead of N
/// stacked cards that eat the phone viewport.
///
/// Low-signal event cards (reasoning, status, activity, todo, etc.) do NOT
/// break a cluster — Claude typically emits a reasoning entry between every
/// two tool calls, and a naive "consecutive" check would prevent any grouping
/// at all. They are buffered and re-emitted after the cluster so the
/// narrative order (tools first, then reasoning) stays readable. Hard
/// boundaries (messages, turn separators, approvals, pending inputs, usage
/// summaries, artifacts) flush the cluster so the group never swallows a
/// different turn's work. Runs of size 1 stay ungrouped.
func collapseConsecutiveWorkToolEntries(_ entries: [WorkTimelineEntry]) -> [WorkTimelineEntry] {
  var result: [WorkTimelineEntry] = []
  result.reserveCapacity(entries.count)
  var cluster: [WorkTimelineEntry] = []
  var buffered: [WorkTimelineEntry] = []

  func flushCluster() {
    if cluster.count >= 2 {
      let members = cluster.compactMap(workToolGroupMember(from:))
      if members.count == cluster.count {
        let anchor = cluster[0]
        let groupId = "tool-group:\(anchor.id)"
        result.append(WorkTimelineEntry(
          id: groupId,
          timestamp: anchor.timestamp,
          rank: anchor.rank,
          payload: .toolGroup(WorkToolGroupModel(id: groupId, members: members))
        ))
      } else {
        result.append(contentsOf: cluster)
      }
    } else {
      result.append(contentsOf: cluster)
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

/// Soft-break entries don't end a tool cluster — they get buffered and
/// re-emitted after the cluster so micro-events (status pings, todo updates,
/// activity beacons) don't stop grouping. Reasoning is explicitly a HARD
/// break: it's the narrative beat between tool uses and should visually
/// separate clusters the same way it does on desktop. All transcript-level
/// boundaries (messages, turn separators, usage, pending inputs, artifacts,
/// completion reports, plans) are hard breaks too.
private func workToolGroupSoftBreak(_ entry: WorkTimelineEntry) -> Bool {
  guard case .eventCard(let card) = entry.payload else { return false }
  switch card.kind {
  case "status", "activity", "todo", "notice",
       "autoApproval", "pendingInputResolved",
       "promptSuggestion", "toolUseSummary":
    return true
  default:
    return false
  }
}

func normalizedWorkLocalEchoText(_ text: String) -> String {
  text
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
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

func buildWorkEventCards(
  from transcript: [WorkChatEnvelope],
  suppressedItemIds: Set<String> = []
) -> [WorkEventCardModel] {
  var byId: [String: WorkEventCardModel] = [:]
  var order: [String] = []
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
    guard let card = eventCard(for: envelope) else { continue }
    if let existing = byId[card.id], let merged = mergedWorkEventCard(existing, with: card) {
      byId[card.id] = merged
    } else {
      if byId[card.id] == nil { order.append(card.id) }
      byId[card.id] = card
    }
  }
  return order.compactMap { byId[$0] }
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
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  let fallbackFormatter = ISO8601DateFormatter()
  fallbackFormatter.formatOptions = [.withInternetDateTime]

  let lhsDate = formatter.date(from: lhs) ?? fallbackFormatter.date(from: lhs)
  let rhsDate = formatter.date(from: rhs) ?? fallbackFormatter.date(from: rhs)

  if let lhsDate, let rhsDate {
    return rhsDate >= lhsDate ? rhs : lhs
  }
  if rhsDate != nil { return rhs }
  return lhs
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
  return incoming
}

/// Map pending-input itemIds to the timestamp of their originating envelope so
/// inline timeline entries sort into the chronological slot where the host
/// first requested input, not the current "now".
func workPendingInputTimestamps(from transcript: [WorkChatEnvelope]) -> [String: String] {
  var result: [String: String] = [:]
  for envelope in transcript {
    switch envelope.event {
    case .approvalRequest(_, _, let itemId, _),
         .structuredQuestion(_, _, let itemId, _):
      if result[itemId] == nil { result[itemId] = envelope.timestamp }
    case .toolCall(let tool, _, let itemId, _, _):
      if isQuestionInputToolName(tool), result[itemId] == nil {
        result[itemId] = envelope.timestamp
      }
    default:
      continue
    }
  }
  return result
}

private func eventCard(for envelope: WorkChatEnvelope) -> WorkEventCardModel? {
  switch envelope.event {
    case .activity:
      // Activity events ("searching_glob", "running_bash", etc.) are pre-tool
      // announcements. The corresponding tool card already represents the
      // work, so persisting them as separate timeline entries just stacks
      // redundant rows under each tool group. Live streaming hints come from
      // WorkActivityIndicator, not the persisted timeline.
      return nil
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
        bullets: options.map { $0.label },
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

let workTimelinePageSize = 80

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
    case .pendingQuestion, .pendingPermission, .pendingPlanApproval:
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
  guard !entries.isEmpty else { return entries }
  var seenTurnIds = Set<String>()
  var output: [WorkTimelineEntry] = []
  output.reserveCapacity(entries.count + 4)

  let fallbackModelId = chatSummary?.modelId ?? chatSummary?.model
  let fallbackMetadata = WorkTurnModelMetadata(
    provider: chatSummary?.provider ?? "",
    modelLabel: prettyWorkChatModelName(chatSummary?.model ?? ""),
    modelId: fallbackModelId
  )
  let metadataByTurn = workTurnModelMetadataByTurn(from: transcript, fallback: fallbackMetadata)

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

struct WorkTurnModelMetadata {
  let provider: String
  let modelLabel: String
  let modelId: String?
}

func workTurnModelMetadataByTurn(
  from transcript: [WorkChatEnvelope],
  fallback: WorkTurnModelMetadata? = nil
) -> [String: WorkTurnModelMetadata] {
  var metadataByTurn: [String: WorkTurnModelMetadata] = [:]
  for envelope in transcript {
    guard case .done(_, _, _, let turnId, let model, let modelId) = envelope.event else { continue }
    let normalizedTurnId = turnId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedTurnId.isEmpty else { continue }
    let rawModel = [model, modelId]
      .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
      .first { !$0.isEmpty }
      ?? ""
    let rawModelId = [modelId, model]
      .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
      .first { !$0.isEmpty }
    metadataByTurn[normalizedTurnId] = WorkTurnModelMetadata(
      provider: workModelCatalogGroupKey(for: rawModelId ?? rawModel, currentProvider: fallback?.provider ?? ""),
      modelLabel: rawModel.isEmpty ? fallback?.modelLabel ?? "Model" : prettyWorkChatModelName(rawModel),
      modelId: rawModelId ?? fallback?.modelId
    )
  }
  return metadataByTurn
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
    guard case .done(_, _, let usage, _, _, _) = envelope.event, let usage else { continue }
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
