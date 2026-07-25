import SwiftUI
import UIKit
import AVKit

/// App-wide "last used" chat composer selection — the model + permission/runtime
/// access mode (plus their coupled sub-settings) the user most recently picked or
/// sent with. Restored when the New Chat screen opens so it defaults to the
/// user's last choices instead of hardcoded defaults. Written from the New Chat
/// composer, the in-session inline controls, and the session settings sheet, so
/// "the same as the last time you sent a message or changed it" holds across both
/// in-app chat and CLI launch (which share one composer).
enum WorkComposerPreferences {
  /// Persisted snapshot of the composer's model + access-mode selection.
  struct Selection: Codable, Equatable {
    var provider: String
    var modelId: String
    var runtimeMode: String
    var reasoningEffort: String
    var codexFastMode: Bool
  }

  /// Versioned so a future field change can migrate rather than mis-decode.
  private static let storageKey = "ade.work.lastComposerSelection.v1"
  private static var defaults: UserDefaults { ADESharedContainer.defaults }

  /// The most recent selection, or nil if the user has not started or changed a
  /// chat yet on this device.
  static func load() -> Selection? {
    guard let data = defaults.data(forKey: storageKey) else { return nil }
    return try? JSONDecoder().decode(Selection.self, from: data)
  }

  /// Persists the full selection. Ignored when provider or model are blank so a
  /// half-initialized composer can never clobber a good record.
  static func save(_ selection: Selection) {
    let provider = selection.provider.trimmingCharacters(in: .whitespacesAndNewlines)
    let modelId = selection.modelId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !provider.isEmpty, !modelId.isEmpty else { return }
    var normalized = selection
    normalized.provider = provider
    normalized.modelId = modelId
    guard let data = try? JSONEncoder().encode(normalized) else { return }
    defaults.set(data, forKey: storageKey)
  }

  /// Convenience for call sites that have the fields loose rather than as a
  /// `Selection` value.
  static func save(
    provider: String,
    modelId: String,
    runtimeMode: String,
    reasoningEffort: String,
    codexFastMode: Bool
  ) {
    save(
      Selection(
        provider: provider,
        modelId: modelId,
        runtimeMode: runtimeMode,
        reasoningEffort: reasoningEffort,
        codexFastMode: codexFastMode
      )
    )
  }
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
  let webSearchActions: [CodexWebSearchAction]?
  let webSearchResults: [CodexWebSearchResult]?

  init(
    id: String,
    toolName: String,
    status: WorkToolCardStatus,
    startedAt: String,
    completedAt: String?,
    argsText: String?,
    resultText: String?,
    webSearchActions: [CodexWebSearchAction]? = nil,
    webSearchResults: [CodexWebSearchResult]? = nil
  ) {
    self.id = id
    self.toolName = toolName
    self.status = status
    self.startedAt = startedAt
    self.completedAt = completedAt
    self.argsText = argsText
    self.resultText = resultText
    self.webSearchActions = webSearchActions
    self.webSearchResults = webSearchResults
  }
}

struct WorkNavigationTargets: Equatable {
  let filePaths: [String]
  let pullRequestNumbers: [Int]
}

struct WorkChatMessage: Identifiable, Equatable {
  let id: String
  let role: String
  var markdown: String
  var assistantPreview: WorkAssistantMessagePreview? = nil
  let timestamp: String
  let turnId: String?
  let itemId: String?
  var turnProvider: String? = nil
  var turnModelId: String? = nil
  var steerId: String? = nil
  var deliveryState: String? = nil
  var processed: Bool? = nil
  var attachments: [AgentChatFileRef]? = nil
  var unprocessedResolution: WorkUserMessageResolution? = nil
}

struct WorkLocalEchoMessage: Identifiable, Equatable {
  let id = UUID().uuidString
  let text: String
  let timestamp: String
  var deliveryState: String? = nil
  var attachments: [AgentChatFileRef]? = nil
}

struct WorkPendingApprovalModel: Identifiable, Equatable {
  let id: String
  let description: String
  let detail: String?
}

struct WorkPendingQuestionOption: Equatable {
  let label: String
  let value: String
  let description: String?
  var recommended: Bool = false
  var preview: String? = nil
  var previewFormat: String? = nil
}

struct WorkPendingQuestion: Identifiable, Equatable {
  let questionId: String
  let question: String
  let options: [WorkPendingQuestionOption]
  let allowsFreeform: Bool
  var header: String? = nil
  var defaultAssumption: String? = nil
  var impact: String? = nil
  var multiSelect: Bool = false
  var isSecret: Bool = false

  var id: String { questionId }
}

struct WorkPendingQuestionModel: Identifiable, Equatable {
  let id: String
  let questions: [WorkPendingQuestion]
  var title: String? = nil
  var body: String? = nil
  /// Provider/source that asked the question ("claude", "codex", "cursor"…),
  /// threaded through from the approval/tool-call detail so the card header can
  /// render "{Provider} asks" and tint per-provider. Optional because some
  /// legacy `structured_question` envelopes don't carry it.
  var source: String? = nil

  var primary: WorkPendingQuestion { questions.first ?? WorkPendingQuestion(questionId: "response", question: "", options: [], allowsFreeform: true) }
  var questionId: String { primary.questionId }
  var question: String { primary.question }
  var options: [WorkPendingQuestionOption] { primary.options }
  var allowsFreeform: Bool { primary.allowsFreeform }
  var defaultAssumption: String? { primary.defaultAssumption }
  var impact: String? { primary.impact }
  var multiSelect: Bool { primary.multiSelect }
  var isSecret: Bool { primary.isSecret }
}

/// Shared provider-display-name mapping for chat-surface card headers, mirroring
/// the desktop redesign's `chatSurfaceProviderName`:
///   claude/anthropic → "Claude", codex/openai → "Codex", cursor → "Cursor",
///   droid/factory → "Droid", opencode → "OpenCode", else Title-case the source.
/// Distinct from `providerLabel(_:)` (which says "Anthropic" / "Cursor Composer"
/// / "OpenAI") so the question/plan header verbs read with the short brand name.
func workChatSurfaceProviderName(_ source: String?) -> String {
  let raw = (source ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  guard !raw.isEmpty else { return "Agent" }
  switch raw {
  case "claude", "anthropic": return "Claude"
  case "codex", "openai": return "Codex"
  case "cursor": return "Cursor"
  case "droid", "factory": return "Droid"
  case "opencode": return "OpenCode"
  case "ade": return "ADE"
  default:
    return raw
      .replacingOccurrences(of: "-", with: " ")
      .replacingOccurrences(of: "_", with: " ")
      .split(separator: " ")
      .map { $0.prefix(1).uppercased() + $0.dropFirst() }
      .joined(separator: " ")
  }
}

func workChatPendingInputHeaderVerb(source: String?, fallbackProvider: String?, kind: String) -> String {
  let rawSource = source?.trimmingCharacters(in: .whitespacesAndNewlines)
  let provider = rawSource?.isEmpty == false ? rawSource : fallbackProvider
  let name = workChatSurfaceProviderName(provider)
  return kind == "plan_approval" ? "\(name) · Plan ready" : "\(name) asks"
}

extension WorkPendingQuestionModel {
  /// Header verb shown beside the provider logo: "{Provider} asks".
  var providerHeaderVerb: String { "\(workChatSurfaceProviderName(source)) asks" }

  func providerHeaderVerb(fallbackProvider: String?) -> String {
    workChatPendingInputHeaderVerb(source: source, fallbackProvider: fallbackProvider, kind: "question")
  }
}

extension WorkPendingPlanApprovalModel {
  /// Header verb shown beside the provider logo: "{Provider} · Plan ready".
  var providerHeaderVerb: String { "\(workChatSurfaceProviderName(source)) · Plan ready" }

  func providerHeaderVerb(fallbackProvider: String?) -> String {
    workChatPendingInputHeaderVerb(source: source, fallbackProvider: fallbackProvider, kind: "plan_approval")
  }
}

struct WorkPendingPermissionModel: Identifiable, Equatable {
  let id: String
  let tool: String
  let description: String
  let detail: String?
}

/// Plan-approval pending input. The agent has emitted an `approval_request`
/// with `request.kind == "plan_approval"` — desktop's `ChatProposedPlanCard`
/// equivalent on iOS. Carries the full plan text so the card can render a
/// scrollable formatted block, plus the source label (e.g. "claude", "codex").
struct WorkPendingPlanApprovalModel: Identifiable, Equatable {
  let id: String
  let source: String
  let planText: String
  let title: String
}

struct WorkModelSelectionChoice: Codable, Equatable {
  let provider: String
  let modelId: String
  let reasoningEffort: String?
  let fastMode: Bool?

  var codexFastMode: Bool? { fastMode }

  init(
    provider: String,
    modelId: String,
    reasoningEffort: String?,
    fastMode: Bool? = nil,
    codexFastMode: Bool? = nil
  ) {
    self.provider = provider
    self.modelId = modelId
    self.reasoningEffort = reasoningEffort
    self.fastMode = fastMode ?? codexFastMode
  }

  enum CodingKeys: String, CodingKey {
    case provider
    case modelId
    case reasoningEffort
    case fastMode
    case codexFastMode
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    provider = try container.decode(String.self, forKey: .provider)
    modelId = try container.decode(String.self, forKey: .modelId)
    reasoningEffort = try container.decodeIfPresent(String.self, forKey: .reasoningEffort)
    let canonicalFastMode = try container.decodeIfPresent(Bool.self, forKey: .fastMode)
    let legacyFastMode = try container.decodeIfPresent(Bool.self, forKey: .codexFastMode)
    fastMode = canonicalFastMode ?? legacyFastMode
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(provider, forKey: .provider)
    try container.encode(modelId, forKey: .modelId)
    try container.encodeIfPresent(reasoningEffort, forKey: .reasoningEffort)
    try container.encodeIfPresent(fastMode, forKey: .fastMode)
  }
}

struct WorkPendingModelSelectionModel: Identifiable, Equatable {
  let id: String
  let role: String
  let tag: String
  let workDescription: String?
  let filesHint: [String]
  let dependsOn: [String]
  let availableModelIds: [String]?

  var title: String {
    guard !role.isEmpty else { return "Pick a model" }
    if !tag.isEmpty {
      return "Pick a model for the \"\(tag)\" \(role)"
    }
    return "Pick a model for the \(role)"
  }
}

struct WorkUsageSummary: Equatable {
  var turnCount: Int
  var inputTokens: Int
  var outputTokens: Int
  var cacheReadTokens: Int
  var cacheCreationTokens: Int
  var reasoningTokens: Int = 0
  var totalTokens: Int = 0
  var contextWindow: Int? = nil
  var costUsd: Double
  /// True for provider-reported current-context snapshots (not per-turn totals).
  var isContextSnapshot: Bool = false
}

struct WorkContextUsageViewModel: Equatable {
  var provider: String
  var contextWindow: Int?
  var usedTokens: Int?
  var inputTokens: Int?
  var outputTokens: Int?
  var cacheReadTokens: Int?
  var cacheWriteTokens: Int?
  var reasoningTokens: Int?
  var totalTokens: Int?
  var ratio: Double?
  var windowSource: WorkContextUsageWindowSource?
}

enum WorkContextUsageWindowSource: String, Equatable {
  case runtime
  case registry
}

struct WorkCompletionArtifactModel: Equatable {
  let type: String
  let description: String
  let reference: String?
}

struct WorkCodexStallContext: Equatable {
  let reason: String
  let detectedAt: String?
  let turnStartedAt: String?
  let lastProgressAt: String?
  let automaticRecoveryAttempted: Bool
  var provider: String? = nil
  var recoveryCount: Int = 0
  var providerNeutral: Bool = false
}

struct WorkUserMessageResolution: Equatable {
  let action: String
  let state: String
  let resolvedAt: String
  let replacementMessageId: String?
}

struct WorkCodexRecoveryReceipt: Equatable {
  let action: String
  let state: String
  let automatic: Bool
  let at: String
  var provider: String? = nil
  var recoveryCount: Int = 0
  var providerNeutral: Bool = false
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
  /// Dedicated subagent lifecycle row. Keeping this out of `eventCard` makes
  /// spawn/result rows hard timeline boundaries that tool/activity folding
  /// cannot absorb.
  case subagent(WorkSubagentTimelineRow)
  /// A run of 2+ consecutive interrupt-stopped subagent result rows, folded into
  /// one calm "N agents stopped when you interrupted" card (desktop parity:
  /// `subagent_stopped_group`). Keeps a mass interrupt from rendering as a wall
  /// of identical stopped rows.
  case subagentStoppedGroup(WorkSubagentStoppedGroupModel)
  /// Cluster of consecutive read-only tool-like entries (tool cards,
  /// commands) collapsed into a single header-only row. Tap to reveal the
  /// member list; tap a row to reveal its output. Matches the desktop
  /// `Tool calls (n)` panel.
  case toolGroup(WorkToolGroupModel)
  /// Cluster of consecutive code-change entries (file_change events plus
  /// write-category tool calls) collapsed into a single flat header row.
  /// Collapsed by default like tool calls; tap to reveal per-file rows.
  case changedFiles(WorkChangedFilesGroupModel)
  case eventCard(WorkEventCardModel)
  case usageSummary(WorkUsageSummary)
  case artifact(ComputerUseArtifactSummary)
  /// Centered time + model pill rendered between turns, matching the desktop
  /// transcript's turn separators.
  case turnSeparator(WorkTurnSeparator)
  /// Centered end-of-turn completion row rendered after a terminal `done`
  /// event. Completed turns say "Ran for"; interrupted/failed turns say
  /// "Elapsed" so wall time is never presented as continuous agent work.
  case turnEndMarker(WorkTurnEndMarker)
  case pendingQuestion(WorkPendingQuestionModel)
  case pendingPermission(WorkPendingPermissionModel)
  /// Plan-approval gate: agent has finished planning and is waiting for the
  /// user to Approve & Implement or Reject & Revise before it acts.
  case pendingPlanApproval(WorkPendingPlanApprovalModel)
  /// Orchestration model routing gate: desktop asks the user to choose a
  /// provider/model/reasoning tuple before workers can be spawned.
  case pendingModelSelection(WorkPendingModelSelectionModel)
}

struct WorkAssistantMarkdownBlockRenderModel: Identifiable, Equatable {
  let id: String
  let messageId: String
  let turnId: String?
  let itemId: String?
  let block: WorkMarkdownBlock

  static func == (lhs: WorkAssistantMarkdownBlockRenderModel, rhs: WorkAssistantMarkdownBlockRenderModel) -> Bool {
    lhs.id == rhs.id
      && lhs.messageId == rhs.messageId
      && lhs.turnId == rhs.turnId
      && lhs.itemId == rhs.itemId
      && lhs.block == rhs.block
  }
}

struct WorkAssistantMonospacedRenderModel: Identifiable, Equatable {
  let id: String
  let messageId: String
  let turnId: String?
  let itemId: String?
  let text: String
  let accessibilityLabel: String

  static func == (lhs: WorkAssistantMonospacedRenderModel, rhs: WorkAssistantMonospacedRenderModel) -> Bool {
    lhs.id == rhs.id
      && lhs.messageId == rhs.messageId
      && lhs.turnId == rhs.turnId
      && lhs.itemId == rhs.itemId
      && lhs.text == rhs.text
      && lhs.accessibilityLabel == rhs.accessibilityLabel
  }
}

struct WorkAssistantMessageControlsModel: Identifiable, Equatable {
  let id: String
  let messageId: String
  let summaryText: String
  let visibleLineCount: Int
  let totalLineCount: Int
  let canShowMore: Bool
  let nextLineBudget: Int

  static func == (lhs: WorkAssistantMessageControlsModel, rhs: WorkAssistantMessageControlsModel) -> Bool {
    lhs.id == rhs.id
      && lhs.messageId == rhs.messageId
      && lhs.summaryText == rhs.summaryText
      && lhs.visibleLineCount == rhs.visibleLineCount
      && lhs.totalLineCount == rhs.totalLineCount
      && lhs.canShowMore == rhs.canShowMore
      && lhs.nextLineBudget == rhs.nextLineBudget
  }
}

enum WorkTimelineRenderPayload: Equatable {
  case entry(WorkTimelineEntry)
  case assistantMarkdownBlock(WorkAssistantMarkdownBlockRenderModel)
  case assistantMonospaced(WorkAssistantMonospacedRenderModel)
  case assistantControls(WorkAssistantMessageControlsModel)
}

struct WorkTimelineRenderEntry: Identifiable, Equatable {
  let id: String
  let sourceEntryId: String
  let timestamp: String
  let payload: WorkTimelineRenderPayload
}

/// One member of a `WorkToolGroupModel`. Carries enough context for the
/// collapsed mini-row (icon, title, status) and hands the full payload back
/// when the group expands into per-entry cards.
enum WorkToolGroupMember: Equatable, Identifiable {
  case tool(WorkToolCardModel)
  case command(WorkCommandCardModel)
  case fileChange(WorkFileChangeCardModel)

  var id: String {
    switch self {
    case .tool(let card): return "tool:\(card.id)"
    case .command(let card): return "command:\(card.id)"
    case .fileChange(let card): return "file:\(card.id)"
    }
  }

  var timestamp: String {
    switch self {
    case .tool(let card): return card.startedAt
    case .command(let card): return card.timestamp
    case .fileChange(let card): return card.timestamp
    }
  }

  var status: WorkToolCardStatus {
    switch self {
    case .tool(let card): return card.status
    case .command(let card): return card.status
    case .fileChange(let card): return card.status
    }
  }
}

struct WorkToolGroupModel: Identifiable, Equatable {
  let id: String
  let members: [WorkToolGroupMember]

  var hasRunning: Bool { members.contains { $0.status == .running } }
  var latest: WorkToolGroupMember? { members.last }
  var count: Int { members.count }
}

/// One file's worth of aggregated diff data inside a `WorkChangedFilesGroupModel`.
/// Stats are summed across every event that touched the same path during the
/// cluster, so a file edited by both an `Edit` tool and a `file_change` event
/// renders as a single row.
struct WorkChangedFileEntry: Identifiable, Equatable {
  let id: String
  let path: String
  let kind: String
  let additions: Int
  let deletions: Int
  let diff: String
  let status: WorkToolCardStatus
}

struct WorkChangedFilesGroupModel: Identifiable, Equatable {
  let id: String
  let files: [WorkChangedFileEntry]

  var hasRunning: Bool { files.contains { $0.status == .running } }
  var count: Int { files.count }
  var totalAdditions: Int { files.reduce(0) { $0 + $1.additions } }
  var totalDeletions: Int { files.reduce(0) { $0 + $1.deletions } }
}

struct WorkTurnSeparator: Equatable {
  let time: String
  let provider: String
  let modelLabel: String
  let modelId: String?
}

struct WorkTurnEndMarker: Equatable {
  let turnId: String
  let time: String
  let workedDurationLabel: String
  let status: String
  let terminalReasonLabel: String?
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
  enum Status: Equatable { case running, succeeded, failed, stopped }

  let taskId: String
  let agentId: String?
  let agentType: String?
  let parentToolUseId: String?
  let description: String
  let background: Bool
  let label: String?
  let model: String?
  let reasoningEffort: String?
  let status: Status
  let lastToolName: String?
  let latestSummary: String?
  let turnId: String?
  let startedAt: String?
  let updatedAt: String?
  /// Raw runtime classification used to distinguish background shell commands
  /// from real background agents. Defaults preserve older roster payloads.
  var taskType: String? = nil
  var command: String? = nil

  var id: String { taskId }
}

struct WorkSubagentTimelineRow: Identifiable, Equatable {
  enum Kind: String, Equatable {
    case spawn
    case result
    case backgroundCommand
  }

  let kind: Kind
  let snapshot: WorkSubagentSnapshot
  let timestamp: String
  let summary: String?
  let commandLabel: String?
  let exitLabel: String?

  var id: String {
    "subagent-\(kind.rawValue)-\(snapshot.agentId ?? snapshot.taskId)"
  }
}

/// Folded run of 2+ interrupt-stopped subagent result rows (desktop parity:
/// `SubagentStoppedGroupEvent`). Carries the original result rows so the card
/// can list each agent's title and reopen its detail on tap.
struct WorkSubagentStoppedGroupModel: Identifiable, Equatable {
  let id: String
  let rows: [WorkSubagentTimelineRow]

  var count: Int { rows.count }
}

struct WorkSubagentSelection: Identifiable, Equatable {
  let taskId: String
  let agentId: String?
  let name: String
  let status: WorkSubagentSnapshot.Status
  let background: Bool

  var id: String { taskId }
}

struct WorkScheduledWorkSnapshot: Identifiable, Equatable {
  let id: String
  let kind: String
  var status: String
  let origin: String?
  let title: String
  let summary: String?
  let prompt: String?
  let reason: String?
  let cron: String?
  let nextRunAt: String?
  let lastRunAt: String?
  let firedAt: String?
  let late: Bool?
  let recurring: Bool?
  let durable: Bool?
  let cancellable: Bool?
  let sourceToolUseId: String?
  let sourceTaskId: String?
  let turnId: String?
  let error: String?
  let createdAt: String
  let updatedAt: String
}

struct WorkChatTimelineSnapshot: Equatable {
  var signature: Int
  var pendingInputs: [WorkPendingInputItem]
  var pendingSteers: [WorkPendingSteerModel]
  var toolCards: [WorkToolCardModel]
  var eventCards: [WorkEventCardModel]
  var commandCards: [WorkCommandCardModel]
  var fileChangeCards: [WorkFileChangeCardModel]
  var subagentSnapshots: [WorkSubagentSnapshot]
  var scheduledWorkSnapshots: [WorkScheduledWorkSnapshot]
  var transcriptIndicatesActiveTurn: Bool
  var transcriptLatestTurnEnded: Bool
  var transcriptHasInterruptibleActivity: Bool
  var latestTranscriptTimestamp: String?
  var latestMessageAssistantId: String?
  var timeline: [WorkTimelineEntry]

  static let empty = WorkChatTimelineSnapshot(
    signature: 0,
    pendingInputs: [],
    pendingSteers: [],
    toolCards: [],
    eventCards: [],
    commandCards: [],
    fileChangeCards: [],
    subagentSnapshots: [],
    scheduledWorkSnapshots: [],
    transcriptIndicatesActiveTurn: false,
    transcriptLatestTurnEnded: false,
    transcriptHasInterruptibleActivity: false,
    latestTranscriptTimestamp: nil,
    latestMessageAssistantId: nil,
    timeline: []
  )

  static func == (lhs: WorkChatTimelineSnapshot, rhs: WorkChatTimelineSnapshot) -> Bool {
    lhs.signature == rhs.signature
  }
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
  /// Set for lifecycle-style cards (e.g. `kind == "contextCompact"`) that begin
  /// in a live state and later settle. When true the card renders its
  /// in-progress affordance (spinner + "Compacting context…"); once the host
  /// emits the completed event the merged card flips this back to false.
  let isInProgress: Bool
  /// Structured question payload for `kind == "question"`, so the resolved
  /// transcript card can render the provider logo, the question text, and clean
  /// option rows (with the recommended/selected option marked) instead of the
  /// flat "Extras: … Options: …" bullet dump.
  let questionModel: WorkPendingQuestionModel?
  /// Structured plan payload for `kind == "planApproval"`, so the resolved card
  /// can render a markdown preview + expand-to-sheet instead of per-line bullets.
  let planApprovalModel: WorkPendingPlanApprovalModel?
  /// Resolution word (`accepted` / `declined` / `cancelled` / a chosen value)
  /// joined from the matching `pending_input_resolved` event. Lets the question
  /// and plan cards fold the resolved state inline and drop the separate
  /// floating "Input resolved · Accepted" ribbon.
  let resolution: String?
  /// Action context for a live `codex_turn_stalled` recovery card. The source
  /// session can differ from the visible parent chat when a child agent stalls.
  let recoveryOptions: [String]
  let recoveryTurnId: String?
  let recoverySessionId: String?
  let recoveryContext: WorkCodexStallContext?
  let recoveryReceipt: WorkCodexRecoveryReceipt?
  /// Aggregated, low-noise diagnostics disclosed from "Turn details" instead
  /// of rendering each routine moderation or optional integration event.
  let diagnosticModerationChecks: Int
  let diagnosticIntegrationFailures: [AgentChatOptionalIntegrationFailure]

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
    planSteps: [WorkPlanStep] = [],
    isInProgress: Bool = false,
    questionModel: WorkPendingQuestionModel? = nil,
    planApprovalModel: WorkPendingPlanApprovalModel? = nil,
    resolution: String? = nil,
    recoveryOptions: [String] = [],
    recoveryTurnId: String? = nil,
    recoverySessionId: String? = nil,
    recoveryContext: WorkCodexStallContext? = nil,
    recoveryReceipt: WorkCodexRecoveryReceipt? = nil,
    diagnosticModerationChecks: Int = 0,
    diagnosticIntegrationFailures: [AgentChatOptionalIntegrationFailure] = []
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
    self.isInProgress = isInProgress
    self.questionModel = questionModel
    self.planApprovalModel = planApprovalModel
    self.resolution = resolution
    self.recoveryOptions = recoveryOptions
    self.recoveryTurnId = recoveryTurnId
    self.recoverySessionId = recoverySessionId
    self.recoveryContext = recoveryContext
    self.recoveryReceipt = recoveryReceipt
    self.diagnosticModerationChecks = diagnosticModerationChecks
    self.diagnosticIntegrationFailures = diagnosticIntegrationFailures
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

func workRemoveLoadedArtifactTempFile(_ content: WorkLoadedArtifactContent?) {
  guard case .video(let url) = content,
        url.isFileURL,
        url.lastPathComponent.hasPrefix("ade-work-artifact-") else {
    return
  }
  try? FileManager.default.removeItem(at: url)
}

struct WorkChatEnvelope: Identifiable, Equatable {
  var id: String {
    switch event {
    case .assistantText(_, let turnId, let itemId):
      let normalizedItemId = itemId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      if !normalizedItemId.isEmpty {
        return [
          sessionId,
          "assistant-text",
          turnId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "",
          normalizedItemId,
        ].joined(separator: ":")
      }
    default:
      break
    }
    return "\(sessionId):\(sequence ?? -1):\(timestamp):\(event.typeKey)"
  }
  let sessionId: String
  let timestamp: String
  let sequence: Int?
  let event: WorkChatEvent
  /// Raw fields intentionally kept beside the normalized event so the broad
  /// WorkChatEvent associated-value surface does not need to grow just for
  /// subagent classification.
  let subagentTaskType: String?
  let subagentCommand: String?

  init(
    sessionId: String,
    timestamp: String,
    sequence: Int?,
    event: WorkChatEvent,
    subagentTaskType: String? = nil,
    subagentCommand: String? = nil
  ) {
    self.sessionId = sessionId
    self.timestamp = timestamp
    self.sequence = sequence
    self.event = event
    self.subagentTaskType = subagentTaskType
    self.subagentCommand = subagentCommand
  }
}

enum WorkChatEvent: Equatable {
  case userMessage(text: String, attachments: [AgentChatFileRef]?, turnId: String?, steerId: String?, deliveryState: String?, processed: Bool?)
  case userMessageResolution(
    steerId: String,
    action: String,
    state: String,
    resolvedAt: String,
    replacementMessageId: String?,
    turnId: String?
  )
  case assistantText(text: String, turnId: String?, itemId: String?)
  case toolCall(tool: String, argsText: String, itemId: String, parentItemId: String?, turnId: String?)
  case toolResult(tool: String, resultText: String, itemId: String, parentItemId: String?, turnId: String?, status: WorkToolCardStatus)
  case activity(kind: String, detail: String?, turnId: String?)
  case plan(steps: [WorkPlanStep], explanation: String?, turnId: String?)
  case subagentStarted(taskId: String, agentId: String?, agentType: String?, parentToolUseId: String?, description: String, background: Bool, label: String?, model: String?, reasoningEffort: String?, turnId: String?)
  case subagentProgress(taskId: String, agentId: String?, agentType: String?, parentToolUseId: String?, description: String?, summary: String, toolName: String?, label: String?, model: String?, reasoningEffort: String?, turnId: String?)
  case subagentResult(taskId: String, agentId: String?, agentType: String?, parentToolUseId: String?, status: String, summary: String, label: String?, model: String?, reasoningEffort: String?, turnId: String?)
  case scheduledWorkUpdate(id: String, kind: String, status: String, origin: String?, title: String?, summary: String?, prompt: String?, reason: String?, cron: String?, nextRunAt: String?, lastRunAt: String?, firedAt: String?, late: Bool?, recurring: Bool?, durable: Bool?, sourceToolUseId: String?, sourceTaskId: String?, turnId: String?, error: String?)
  case transcriptRetraction(messageIds: [String], reason: String?, replacementMessageId: String?, turnId: String?)
  case structuredQuestion(question: String, options: [WorkPendingQuestionOption], itemId: String, turnId: String?)
  case approvalRequest(description: String, detail: String?, itemId: String, turnId: String?)
  case pendingInputResolved(itemId: String, resolution: String, turnId: String?)
  case todoUpdate(items: [String], turnId: String?)
  case systemNotice(kind: String, message: String, detail: String?, turnId: String?, steerId: String?)
  case error(message: String, detail: String?, category: String, turnId: String?)
  case done(status: String, summary: String, usage: WorkUsageSummary?, turnId: String, model: String?, modelId: String?, terminalReason: String? = nil)
  case tokens(usage: WorkUsageSummary, turnId: String, itemId: String?)
  case promptSuggestion(text: String, turnId: String?)
  case contextCompact(summary: String, isInProgress: Bool, postTokens: Int?, turnId: String?, compactionId: String?)
  case claudeGoalUpdated(goal: AgentChatClaudeGoal, turnId: String?)
  case claudeGoalCleared(turnId: String?)
  case autoApprovalReview(summary: String, turnId: String?)
  case webSearch(query: String, action: String?, actions: [CodexWebSearchAction]?, results: [CodexWebSearchResult]?, status: WorkToolCardStatus, itemId: String, turnId: String?)
  case codexState(title: String, message: String, icon: String, turnId: String?)
  case turnDiagnostics(
    moderationChecks: Int,
    optionalIntegrationFailures: [AgentChatOptionalIntegrationFailure],
    turnId: String?
  )
  case codexTurnStalled(
    message: String,
    recoveryOptions: [String],
    turnId: String?,
    sourceSessionId: String?,
    context: WorkCodexStallContext
  )
  case codexTurnRecovery(
    message: String,
    receipt: WorkCodexRecoveryReceipt,
    turnId: String?
  )
  case planText(text: String, turnId: String?)
  case toolUseSummary(text: String, turnId: String?)
  case status(turnStatus: String, message: String?, turnId: String?)
  case reasoning(text: String, turnId: String?, itemId: String?, summaryIndex: Int?)
  case completionReport(summary: String, status: String, artifacts: [WorkCompletionArtifactModel], blockerDescription: String?, turnId: String?)
  case command(command: String, cwd: String, output: String, status: WorkToolCardStatus, itemId: String, exitCode: Int?, durationMs: Int?, turnId: String?)
  case fileChange(path: String, diff: String, kind: String, status: WorkToolCardStatus, itemId: String, turnId: String?)
  case unknown(type: String)

  var typeKey: String {
    switch self {
    case .userMessage: return "user_message"
    case .userMessageResolution: return "user_message_resolution"
    case .assistantText: return "text"
    case .toolCall: return "tool_call"
    case .toolResult: return "tool_result"
    case .activity: return "activity"
    case .plan: return "plan"
    case .subagentStarted: return "subagent_started"
    case .subagentProgress: return "subagent_progress"
    case .subagentResult: return "subagent_result"
    case .scheduledWorkUpdate: return "scheduled_work_update"
    case .transcriptRetraction: return "transcript_retraction"
    case .structuredQuestion: return "structured_question"
    case .approvalRequest: return "approval_request"
    case .pendingInputResolved: return "pending_input_resolved"
    case .todoUpdate: return "todo_update"
    case .systemNotice: return "system_notice"
    case .error: return "error"
    case .done: return "done"
    case .tokens: return "tokens"
    case .promptSuggestion: return "prompt_suggestion"
    case .contextCompact: return "context_compact"
    case .claudeGoalUpdated: return "claude_goal_updated"
    case .claudeGoalCleared: return "claude_goal_cleared"
    case .autoApprovalReview: return "auto_approval_review"
    case .webSearch: return "web_search"
    case .codexState: return "codex_state"
    case .turnDiagnostics: return "turn_diagnostics"
    case .codexTurnStalled: return "codex_turn_stalled"
    case .codexTurnRecovery: return "codex_turn_recovery"
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
