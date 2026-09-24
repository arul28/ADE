import Foundation

private func workTaskStatus(_ raw: String) -> WorkChatTaskStatus {
  switch raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
  case "in_progress", "in-progress", "running": return .running
  case "completed", "complete", "done": return .done
  case "failed", "error": return .failed
  default: return .pending
  }
}

private func workTaskListLabel(source: String, explanation: String?) -> String {
  let trimmed = explanation?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  guard !trimmed.isEmpty, trimmed.count <= 60, !trimmed.contains("\n"), !trimmed.contains("\r") else {
    return source == "plan" ? "Plan" : "Tasks"
  }
  return trimmed
}

private func workTodoItem(_ item: AgentChatTodoItem, index: Int) -> WorkChatTaskItem? {
  let label = item.description.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !label.isEmpty else { return nil }
  let activeLabel = item.activeForm?.trimmingCharacters(in: .whitespacesAndNewlines)
  let skipped = item.cancelled == true
  return WorkChatTaskItem(
    id: item.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "todo-\(index)" : item.id,
    label: label,
    status: skipped ? .done : workTaskStatus(item.status.rawValue),
    activeLabel: activeLabel.flatMap { $0.isEmpty || $0 == label ? nil : $0 },
    skipped: skipped,
    priority: nil
  )
}

private func workPlanTask(_ step: WorkPlanStep, index: Int) -> WorkChatTaskItem? {
  let label = step.text.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !label.isEmpty else { return nil }
  return WorkChatTaskItem(
    id: "step-\(index)",
    label: label,
    status: step.cancelled ? .done : workTaskStatus(step.status),
    activeLabel: nil,
    skipped: step.cancelled,
    priority: step.priority
  )
}

private func uniqueWorkTaskIds(_ items: [WorkChatTaskItem]) -> [WorkChatTaskItem] {
  var seen = Set<String>()
  return items.enumerated().map { index, item in
    let base = item.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "task-\(index)" : item.id
    var id = base
    var suffix = 2
    while !seen.insert(id).inserted {
      id = "\(base)#\(suffix)"
      suffix += 1
    }
    guard id != item.id else { return item }
    var copy = item
    copy.id = id
    return copy
  }
}

func buildWorkChatTaskListSnapshot(from transcript: [WorkChatEnvelope]) -> WorkChatTaskListSnapshot? {
  var current: WorkChatTaskListSnapshot?
  for envelope in sortedWorkChatEnvelopes(transcript) {
    switch envelope.event {
    case .plan(let steps, let explanation, let turnId):
      let items = uniqueWorkTaskIds(steps.enumerated().compactMap { workPlanTask($0.element, index: $0.offset) })
      guard !items.isEmpty else {
        current = nil
        continue
      }
      current = WorkChatTaskListSnapshot(
        source: "plan",
        label: workTaskListLabel(source: "plan", explanation: explanation),
        items: items,
        turnId: turnId,
        timestamp: envelope.timestamp
      )
    case .planProposal:
      continue
    case .taskListUpdate(let todos, let turnId):
      let incoming = uniqueWorkTaskIds(todos.enumerated().compactMap { workTodoItem($0.element, index: $0.offset) })
      guard !incoming.isEmpty else {
        current = nil
        continue
      }
      if let existing = current, existing.source == "plan",
         ((turnId != nil && turnId == existing.turnId)
           || incoming.allSatisfy({ todo in existing.items.contains(where: { $0.id == todo.id || $0.label == todo.label }) })) {
        var items = existing.items
        for update in incoming {
          if let index = items.firstIndex(where: { $0.id == update.id })
            ?? items.firstIndex(where: { $0.label == update.label }) {
            items[index].status = update.status
            items[index].activeLabel = update.activeLabel
            items[index].skipped = update.skipped
          } else {
            items.append(update)
          }
        }
        current = WorkChatTaskListSnapshot(
          source: existing.source,
          label: existing.label,
          items: uniqueWorkTaskIds(items),
          turnId: turnId ?? existing.turnId,
          timestamp: envelope.timestamp
        )
      } else {
        current = WorkChatTaskListSnapshot(
          source: "todo",
          label: "Tasks",
          items: uniqueWorkTaskIds(incoming),
          turnId: turnId,
          timestamp: envelope.timestamp
        )
      }
    default:
      continue
    }
  }
  return current
}
