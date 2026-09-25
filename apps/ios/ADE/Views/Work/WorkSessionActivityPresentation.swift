private let workCopilotPlanModeId = "https://agentclientprotocol.com/protocol/session-modes#plan"

private func workCursorPlanningModeId(_ snapshot: RemoteJSONValue?) -> String? {
  guard case .object(let object)? = snapshot,
        case .string(let currentModeId)? = object["currentModeId"]
  else { return nil }
  return currentModeId
}

/// Extract ACP's current mode using the same currentModeId → `mode` option
/// fallback as desktop. Non-string option values are not mode identifiers.
private func workAcpCurrentModeId(_ snapshot: RemoteJSONValue?) -> String? {
  guard case .object(let object)? = snapshot else { return nil }
  if let currentMode = object["currentModeId"] {
    switch currentMode {
    case .string(let value): return value
    case .null: break
    default: return nil
    }
  }
  guard case .array(let options)? = object["configOptions"],
        let option = options.first(where: { value in
          guard case .object(let fields) = value,
                case .string(let id)? = fields["id"]
          else { return false }
          return id == "mode"
        }),
        case .object(let fields) = option,
        case .string(let value)? = fields["currentValue"]
  else { return nil }
  return value
}

/// Planning is a presentation fact, never a canonical phase. Mirror desktop's
/// provider-specific `chatIsPlanning` checks. Permission posture alone is not
/// evidence that a provider accepted Plan mode.
func workSessionIsPlanning(summary: AgentChatSessionSummary?) -> Bool {
  guard let summary else { return false }
  switch summary.provider {
  case "claude":
    return summary.interactionMode == "plan"
  case "codex":
    return summary.codexEffectiveCollaborationMode == "plan"
  case "cursor":
    if summary.cursorModeIdWasCleared == true || summary.cursorModeId != nil {
      return summary.cursorModeId == "plan"
    }
    return workCursorPlanningModeId(summary.cursorModeSnapshot) == "plan"
  case "droid":
    return summary.interactionMode == "plan"
  case "opencode":
    return summary.opencodePermissionMode == "plan"
  case "qwen", "kimi":
    guard summary.acpConfigSnapshotWasCleared != true else { return false }
    return workAcpCurrentModeId(summary.acpConfigSnapshot) == "plan"
  case "copilot":
    guard summary.acpConfigSnapshotWasCleared != true else { return false }
    return workAcpCurrentModeId(summary.acpConfigSnapshot) == workCopilotPlanModeId
  default:
    return false
  }
}

/// Mirrors `SESSION_ACTIVITY_VALUES` in `apps/desktop/src/shared/types/sessions.ts`.
let workSessionActivityValues: Set<String> = [
  "planning", "exploring", "implementing", "testing", "debugging", "reviewing", "shipping", "monitoring",
]

/// The activity detail that refines a running Work row's one status slot:
/// detected by the host from the turn's tool calls, or reported by the agent.
/// Mirrors `currentActivityReport` in `sessionStatusPresentation.ts`: an agent
/// report must belong to the current turn, a detected one may carry across a
/// continuation turn (the host clears it whenever the user engages). A tracked
/// CLI row has no chat turn marker, so its explicit report is the best
/// available signal.
func workSessionActivityDetailPresentation(
  session: TerminalSessionSummary,
  phase: CanonicalSessionPhase,
  currentTurnStartedAt: String?
) -> WorkSessionStatusPresentation? {
  guard phase == .running else { return nil }

  let hasLiveChatTurn = !isWorkChatToolType(session.toolType)
    || currentTurnStartedAt.flatMap(workParsedDate) != nil
  guard hasLiveChatTurn,
        let activityStatus = session.activityStatus,
        activityStatus.source == "agent" || activityStatus.source == "detected",
        workSessionActivityValues.contains(activityStatus.value),
        let updatedAt = workParsedDate(activityStatus.updatedAt)
  else { return nil }

  let isStaleForTurn = activityStatus.source == "agent" && (currentTurnStartedAt
    .flatMap(workParsedDate)
    .map { updatedAt < $0 } ?? false)
  guard !isStaleForTurn else { return nil }

  let isPlanning = activityStatus.value == "planning"
  return WorkSessionStatusPresentation(
    label: activityStatus.value.capitalized,
    tone: isPlanning ? .violet : .blue,
    glyph: ActivityGlyph(rawValue: activityStatus.value) ?? .working,
    showsElapsed: true,
    prominent: false,
    kind: nil,
    activityReportUpdatedAt: activityStatus.updatedAt
  )
}
