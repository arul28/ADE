import SwiftUI
import UIKit
import AVKit

struct WorkAgentActivityContext: Equatable {
  let sessionId: String
  let title: String
  let laneName: String
  let status: String
  let startedAt: String
}

struct WorkAgentActivity: Identifiable, Equatable {
  var id: String { "\(sessionId):\(taskId ?? "session")" }
  let sessionId: String
  let taskId: String?
  let agentName: String
  let toolName: String?
  let laneName: String
  let startedAt: String
  let detail: String?
}

enum WorkToolCardStatus: String, Equatable {
  case running
  case completed
  case failed
}

struct WorkToolCardModel: Identifiable, Equatable {
  let id: String
  let toolName: String
  let status: WorkToolCardStatus
  let startedAt: String
  let completedAt: String?
  let argsText: String?
  let resultText: String?
}

struct WorkNavigationTargets: Equatable {
  let filePaths: [String]
  let pullRequestNumbers: [Int]
}

struct WorkChatMessage: Identifiable, Equatable {
  let id: String
  let role: String
  var markdown: String
  let timestamp: String
  let turnId: String?
  let itemId: String?
  var steerId: String? = nil
  var deliveryState: String? = nil
  var processed: Bool? = nil
}

struct WorkLocalEchoMessage: Identifiable, Equatable {
  let id = UUID().uuidString
  let text: String
  let timestamp: String
}

struct WorkPendingApprovalModel: Identifiable, Equatable {
  let id: String
  let description: String
  let detail: String?
}

struct WorkPendingQuestionModel: Identifiable, Equatable {
  let id: String
  let question: String
  let options: [String]
}

struct WorkUsageSummary: Equatable {
  var turnCount: Int
  var inputTokens: Int
  var outputTokens: Int
  var cacheReadTokens: Int
  var cacheCreationTokens: Int
  var costUsd: Double
}

struct WorkCompletionArtifactModel: Equatable {
  let type: String
  let description: String
  let reference: String?
}

struct WorkCommandCardModel: Identifiable, Equatable {
  let id: String
  let command: String
  let cwd: String
  let output: String
  let status: WorkToolCardStatus
  let timestamp: String
  let exitCode: Int?
  let durationMs: Int?
}

struct WorkFileChangeCardModel: Identifiable, Equatable {
  let id: String
  let path: String
  let diff: String
  let kind: String
  let status: WorkToolCardStatus
  let timestamp: String
}

enum WorkTimelinePayload: Equatable {
  case message(WorkChatMessage)
  case toolCard(WorkToolCardModel)
  case commandCard(WorkCommandCardModel)
  case fileChangeCard(WorkFileChangeCardModel)
  case eventCard(WorkEventCardModel)
  case usageSummary(WorkUsageSummary)
  case artifact(ComputerUseArtifactSummary)
  /// Centered time + model pill rendered between turns, matching the desktop
  /// transcript's turn separators.
  case turnSeparator(WorkTurnSeparator)
}

struct WorkTurnSeparator: Equatable {
  let time: String
  let provider: String
  let modelLabel: String
  let modelId: String?
}

struct WorkTimelineEntry: Identifiable, Equatable {
  let id: String
  let timestamp: String
  let rank: Int
  let payload: WorkTimelinePayload
}

struct WorkSubagentSnapshot: Identifiable, Equatable {
  enum Status: Equatable { case running, succeeded, failed }

  let taskId: String
  let description: String
  let background: Bool
  let status: Status
  let lastToolName: String?
  let latestSummary: String?
  let turnId: String?

  var id: String { taskId }
}

struct WorkChatTimelineSnapshot: Equatable {
  var pendingInputs: [WorkPendingInputItem]
  var pendingSteers: [WorkPendingSteerModel]
  var toolCards: [WorkToolCardModel]
  var eventCards: [WorkEventCardModel]
  var commandCards: [WorkCommandCardModel]
  var fileChangeCards: [WorkFileChangeCardModel]
  var subagentSnapshots: [WorkSubagentSnapshot]
  var timeline: [WorkTimelineEntry]

  static let empty = WorkChatTimelineSnapshot(
    pendingInputs: [],
    pendingSteers: [],
    toolCards: [],
    eventCards: [],
    commandCards: [],
    fileChangeCards: [],
    subagentSnapshots: [],
    timeline: []
  )
}

struct WorkPlanStep: Equatable, Hashable {
  let text: String
  /// Raw host status (e.g. "pending", "in_progress", "completed"). Display code normalizes it.
  let status: String
}

struct WorkEventCardModel: Identifiable, Equatable {
  let id: String
  let kind: String
  let title: String
  let icon: String
  let tint: ColorToken
  let timestamp: String
  let body: String?
  let bullets: [String]
  let metadata: [String]
  /// Populated for `kind == "plan"`. Each step keeps its status so the rich plan
  /// card can paint per-step checkmarks/colors instead of prefixed bullets.
  let planSteps: [WorkPlanStep]

  init(
    id: String,
    kind: String,
    title: String,
    icon: String,
    tint: ColorToken,
    timestamp: String,
    body: String?,
    bullets: [String],
    metadata: [String],
    planSteps: [WorkPlanStep] = []
  ) {
    self.id = id
    self.kind = kind
    self.title = title
    self.icon = icon
    self.tint = tint
    self.timestamp = timestamp
    self.body = body
    self.bullets = bullets
    self.metadata = metadata
    self.planSteps = planSteps
  }
}

enum ColorToken: Equatable {
  case accent
  case success
  case warning
  case danger
  case secondary

  var color: Color {
    switch self {
    case .accent: return ADEColor.accent
    case .success: return ADEColor.success
    case .warning: return ADEColor.warning
    case .danger: return ADEColor.danger
    case .secondary: return ADEColor.textSecondary
    }
  }
}

enum WorkANSIColor: Equatable {
  case red
  case green
  case yellow
  case blue
  case magenta
  case cyan
  case white
  case black
}

struct ANSISegment: Equatable {
  let text: String
  let foreground: WorkANSIColor?
  let bold: Bool
}

struct WorkFullscreenImage: Identifiable {
  let id = UUID().uuidString
  let title: String
  let image: UIImage
}

enum WorkLoadedArtifactContent {
  case image(UIImage)
  case video(URL)
  case remoteURL(URL)
  case text(String)
  case error(String)
}

struct WorkChatEnvelope: Identifiable, Equatable {
  var id: String { "\(sessionId):\(sequence ?? -1):\(timestamp):\(event.typeKey)" }
  let sessionId: String
  let timestamp: String
  let sequence: Int?
  let event: WorkChatEvent
}

enum WorkChatEvent: Equatable {
  case userMessage(text: String, turnId: String?, steerId: String?, deliveryState: String?, processed: Bool?)
  case assistantText(text: String, turnId: String?, itemId: String?)
  case toolCall(tool: String, argsText: String, itemId: String, parentItemId: String?, turnId: String?)
  case toolResult(tool: String, resultText: String, itemId: String, parentItemId: String?, turnId: String?, status: WorkToolCardStatus)
  case activity(kind: String, detail: String?, turnId: String?)
  case plan(steps: [WorkPlanStep], explanation: String?, turnId: String?)
  case subagentStarted(taskId: String, description: String, background: Bool, turnId: String?)
  case subagentProgress(taskId: String, description: String?, summary: String, toolName: String?, turnId: String?)
  case subagentResult(taskId: String, status: String, summary: String, turnId: String?)
  case structuredQuestion(question: String, options: [String], itemId: String, turnId: String?)
  case approvalRequest(description: String, detail: String?, itemId: String, turnId: String?)
  case pendingInputResolved(itemId: String, resolution: String, turnId: String?)
  case todoUpdate(items: [String], turnId: String?)
  case systemNotice(kind: String, message: String, detail: String?, turnId: String?, steerId: String?)
  case error(message: String, detail: String?, category: String, turnId: String?)
  case done(status: String, summary: String, usage: WorkUsageSummary?, turnId: String)
  case promptSuggestion(text: String, turnId: String?)
  case contextCompact(summary: String, turnId: String?)
  case autoApprovalReview(summary: String, turnId: String?)
  case webSearch(query: String, action: String?, status: WorkToolCardStatus, itemId: String, turnId: String?)
  case planText(text: String, turnId: String?)
  case toolUseSummary(text: String, turnId: String?)
  case status(turnStatus: String, message: String?, turnId: String?)
  case reasoning(text: String, turnId: String?)
  case completionReport(summary: String, status: String, artifacts: [WorkCompletionArtifactModel], blockerDescription: String?, turnId: String?)
  case command(command: String, cwd: String, output: String, status: WorkToolCardStatus, itemId: String, exitCode: Int?, durationMs: Int?, turnId: String?)
  case fileChange(path: String, diff: String, kind: String, status: WorkToolCardStatus, itemId: String, turnId: String?)
  case unknown(type: String)

  var typeKey: String {
    switch self {
    case .userMessage: return "user_message"
    case .assistantText: return "text"
    case .toolCall: return "tool_call"
    case .toolResult: return "tool_result"
    case .activity: return "activity"
    case .plan: return "plan"
    case .subagentStarted: return "subagent_started"
    case .subagentProgress: return "subagent_progress"
    case .subagentResult: return "subagent_result"
    case .structuredQuestion: return "structured_question"
    case .approvalRequest: return "approval_request"
    case .pendingInputResolved: return "pending_input_resolved"
    case .todoUpdate: return "todo_update"
    case .systemNotice: return "system_notice"
    case .error: return "error"
    case .done: return "done"
    case .promptSuggestion: return "prompt_suggestion"
    case .contextCompact: return "context_compact"
    case .autoApprovalReview: return "auto_approval_review"
    case .webSearch: return "web_search"
    case .planText: return "plan_text"
    case .toolUseSummary: return "tool_use_summary"
    case .status: return "status"
    case .reasoning: return "reasoning"
    case .completionReport: return "completion_report"
    case .command: return "command"
    case .fileChange: return "file_change"
    case .unknown(let type): return type
    }
  }
}
