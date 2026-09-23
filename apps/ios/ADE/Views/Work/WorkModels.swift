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

struct WorkToolCardModel: Identifiable, Hashable {
  let id: String
  let toolName: String
  let status: WorkToolCardStatus
  let startedAt: String
  let completedAt: String?
  let argsText: String?
  let resultText: String?
  let webSearchActions: [CodexWebSearchAction]?
  let webSearchResults: [CodexWebSearchResult]?
  /// Size of the stored result when `resultText` is only the head slice the
  /// slim mobile wire delivered. nil means the card already has everything,
  /// which is the case for every host and every client that does not use that
  /// wire.
  let remoteResultBytes: Int?
  /// Session this card came from. Needed only to fetch a truncated result, so
  /// it is optional: a card built without one simply cannot offer the fetch.
  let sessionId: String?
  /// Transcript sequence for the result. Retry events may reuse `itemId`, so
  /// the sequence is part of the remote-result cache identity.
  let resultSequence: Int?
  /// Where the result row sits in the host transcript, when the phone read it
  /// off a history page. Turns the fetch into an exact read rather than a
  /// bounded scan that may not reach back this far.
  let resultSourceOffset: Int?

  init(
    id: String,
    toolName: String,
    status: WorkToolCardStatus,
    startedAt: String,
    completedAt: String?,
    argsText: String?,
    resultText: String?,
    webSearchActions: [CodexWebSearchAction]? = nil,
    webSearchResults: [CodexWebSearchResult]? = nil,
    remoteResultBytes: Int? = nil,
    sessionId: String? = nil,
    resultSequence: Int? = nil,
    resultSourceOffset: Int? = nil
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
    self.remoteResultBytes = remoteResultBytes
    self.sessionId = sessionId
    self.resultSequence = resultSequence
    self.resultSourceOffset = resultSourceOffset
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
  /// Digest of `markdown`, stamped once by the (off-main) snapshot fold.
  ///
  /// Change detection used to hash the full text of every visible message on
  /// every presentation refresh — main-thread work proportional to the whole
  /// visible transcript, several times a second during a streaming turn. Nil
  /// only for messages built outside the fold, where the callers below fall
  /// back to hashing the text.
  var markdownDigest: String? = nil
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
  /// Monotonic content revision for the incremental streaming path. The
  /// off-main snapshot fold stamps `markdownDigest` once, but live deltas
  /// mutate the same message on the main actor and must invalidate preview
  /// caches without hashing the entire growing response again.
  var markdownRevision: UInt64 = 0
  /// Exact counts for the append-only streaming path. They are updated from
  /// the incoming delta, so preview summaries do not recount the whole answer
  /// on every token batch. Completed snapshot messages leave these nil and
  /// continue to derive their values from the authoritative markdown.
  var markdownCharacterCount: Int? = nil
  /// Exact UTF-8 byte count for the authoritative markdown. The streaming
  /// merger uses this to avoid rescanning the entire growing response before
  /// deciding whether an incoming provider payload is a fragment or replay.
  var markdownUTF8Count: Int? = nil
  var markdownLineCount: Int? = nil
  var markdownHasCarriageReturn: Bool? = nil
  var markdownContainsFence: Bool? = nil
  /// Number of backticks at the authoritative text's end. This lets a fence
  /// split across two live deltas be recognized without rescanning the full
  /// response.
  var markdownTrailingBacktickRun: Int? = nil
  /// Opening marker for the currently unclosed fence, if the response ends
  /// inside one. Tail previews use it to avoid a full-prefix fence scan.
  var markdownOpenFenceMarker: String? = nil
  /// Incremental fixed-column classification state for the append-only live
  /// path. Completed snapshot messages leave this nil and classify normally.
  var markdownMonospacedClassifier: WorkStreamingMonospacedClassifierState? = nil
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
  /// The ask itself, when the host states one (`detail.request.title`) — e.g.
  /// Pi's "Run bash?" above a description that is only the command. Without it
  /// an `edit` and a `write` gate on the same file look identical.
  var title: String? = nil
}

struct WorkPendingQuestionOption: Hashable {
  let label: String
  let value: String
  let description: String?
  var recommended: Bool = false
  var preview: String? = nil
  var previewFormat: String? = nil
}

struct WorkPendingQuestion: Identifiable, Hashable {
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

struct WorkPendingQuestionModel: Identifiable, Hashable {
  let id: String
  let questions: [WorkPendingQuestion]
  var title: String? = nil
  var body: String? = nil
  /// Provider/source that asked the question ("claude", "codex", "cursor"…),
  /// threaded through from the approval/tool-call detail so the card header can
  /// render "{Provider} asks" and tint per-provider. Optional because some
  /// legacy `structured_question` envelopes don't carry it.
  var source: String? = nil
  /// Codex `isBlocking: false` steering. Missing/true locks the composer.
  var blocking: Bool = true
  /// The host marked this card throw-away-able (`providerMetadata.dismissible`).
  ///
  /// Not the same as `blocking == false`: Codex steering is also non-blocking
  /// and still holds an open app-server request, so dismissing it locally would
  /// strand the turn. Only the host's explicit flag earns the Dismiss button.
  var dismissible: Bool = false

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

/// The payload a structured question card sends: the per-question `answers`
/// map and the single-question `sharedFreeform` that rides `responseText`.
struct WorkQuestionAnswerPayload: Equatable {
  var answers: [String: AgentChatInputAnswerValue]
  var sharedFreeform: String?
}

/// Builds a structured question card's answer payload.
///
/// Mirrors desktop `buildAnswers` (`apps/desktop/src/shared/pendingInputAnswers.ts`):
///
/// 1. A question's option values come first and its own trimmed note last, so a
///    pick and the note typed beside it travel together instead of the `continue`
///    dropping the note. A question with neither contributes no key.
/// 2. On a paged (multi-question) card the shared note is appended to the last
///    answered question's values, or to the first question when none is
///    answered, rather than being discarded.
/// 3. On a single-question card the shared note stays the request's
///    `responseText`.
enum WorkQuestionAnswerBuilder {
  static func build(
    questions: [WorkPendingQuestion],
    selections: [String: Set<String>],
    freeformByQuestion: [String: String],
    sharedFreeform: String,
    isPaged: Bool
  ) -> WorkQuestionAnswerPayload {
    var answers: [String: AgentChatInputAnswerValue] = [:]
    var answeredIds: [String] = []
    for question in questions {
      let selected = selections[question.questionId] ?? []
      let ordered = question.options.map(\.value).filter { selected.contains($0) }
      var values = ordered
      let note = (freeformByQuestion[question.questionId] ?? "")
        .trimmingCharacters(in: .whitespacesAndNewlines)
      if !note.isEmpty { values.append(note) }
      guard !values.isEmpty else { continue }
      answers[question.questionId] = values.count == 1 ? .string(values[0]) : .strings(values)
      answeredIds.append(question.questionId)
    }

    let shared = sharedFreeform.trimmingCharacters(in: .whitespacesAndNewlines)
    if isPaged {
      if !shared.isEmpty, let targetId = answeredIds.last ?? questions.first?.questionId {
        appendSharedNote(shared, to: targetId, in: &answers)
      }
      return WorkQuestionAnswerPayload(answers: answers, sharedFreeform: nil)
    }
    return WorkQuestionAnswerPayload(
      answers: answers,
      sharedFreeform: shared.isEmpty ? nil : shared
    )
  }

  private static func appendSharedNote(
    _ note: String,
    to questionId: String,
    in answers: inout [String: AgentChatInputAnswerValue]
  ) {
    if let existing = answers[questionId] {
      switch existing {
      case .string(let value):
        answers[questionId] = .strings([value, note])
      case .strings(let values):
        answers[questionId] = .strings(values + [note])
      }
    } else {
      answers[questionId] = .string(note)
    }
  }
}

/// Shared provider-display-name mapping for chat-surface card headers, mirroring
/// the desktop redesign's `chatSurfaceProviderName`:
///   claude/anthropic → "Claude", codex/openai → "Codex", cursor → "Cursor",
///   droid/factory → "Droid", opencode → "OpenCode", pi → "Pi", else Title-case the source.
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
  case "pi": return "Pi"
  case "qwen": return "Qwen"
  case "kimi", "moonshot": return "Kimi"
  case "grok", "xai": return "Grok"
  case "copilot", "github-copilot": return "Copilot"
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

func workModelHandoffNoticeMessage(fromProvider: String, toProvider: String) -> String {
  let from = workChatSurfaceProviderName(fromProvider)
  let to = workChatSurfaceProviderName(toProvider)
  return "Model handoff · \(from) → \(to)"
}

/// Packs the two provider ids into the notice `detail` field. Provider ids are
/// slugs (`claude`, `codex`, `opencode`, …) so the pipe is unambiguous, and the
/// notice payload stays a plain `String?` — no model change needed.
func workModelHandoffNoticeDetail(fromProvider: String, toProvider: String) -> String {
  "\(fromProvider)|\(toProvider)"
}

/// Inverse of `workModelHandoffNoticeDetail`. Returns nil when either half is
/// missing — or when the detail carries anything other than exactly two
/// pipe-separated halves — so a malformed row is dropped rather than drawn
/// half-empty.
func workModelHandoffProviders(fromDetail detail: String?) -> (from: String, to: String)? {
  guard let detail else { return nil }
  let parts = detail.split(separator: "|", omittingEmptySubsequences: false)
  guard parts.count == 2 else { return nil }
  let from = parts[0].trimmingCharacters(in: .whitespacesAndNewlines)
  let to = parts[1].trimmingCharacters(in: .whitespacesAndNewlines)
  guard !from.isEmpty, !to.isEmpty else { return nil }
  return (from, to)
}

func workChatPendingInputHeaderVerb(
  source: String?,
  fallbackProvider: String?,
  kind: String,
  blocking: Bool = true
) -> String {
  let rawSource = source?.trimmingCharacters(in: .whitespacesAndNewlines)
  let provider = rawSource?.isEmpty == false ? rawSource : fallbackProvider
  let name = workChatSurfaceProviderName(provider)
  if kind == "plan_approval" { return "\(name) · Plan ready" }
  if !blocking { return "\(name) has a question" }
  return "\(name) asks"
}

/// Live steering is reported on the session row, the chat summary, or both.
/// Either source is enough for the `?` pip; `??` would hide a true summary
/// behind an explicit `false` on the session.
func workCombineSteeringInput(session: Bool?, chatSummary: Bool?) -> Bool {
  session == true || chatSummary == true
}

extension WorkPendingQuestionModel {
  /// Header verb shown beside the provider logo: "{Provider} asks".
  var providerHeaderVerb: String {
    workChatPendingInputHeaderVerb(source: source, fallbackProvider: nil, kind: "question", blocking: blocking)
  }

  func providerHeaderVerb(fallbackProvider: String?) -> String {
    workChatPendingInputHeaderVerb(
      source: source,
      fallbackProvider: fallbackProvider,
      kind: "question",
      blocking: blocking
    )
  }
}

extension WorkPendingPlanApprovalModel {
  /// Header verb shown beside the provider logo: "{Provider} · Plan ready".
  var providerHeaderVerb: String { "\(workChatSurfaceProviderName(source)) · Plan ready" }

  func providerHeaderVerb(fallbackProvider: String?) -> String {
    workChatPendingInputHeaderVerb(source: source, fallbackProvider: fallbackProvider, kind: "plan_approval")
  }
}

struct WorkPendingPermissionModel: Identifiable, Hashable {
  let id: String
  let tool: String
  let description: String
  let detail: String?
}

/// Plan-approval pending input. The agent has emitted an `approval_request`
/// with `request.kind == "plan_approval"` — desktop's `ChatProposedPlanCard`
/// equivalent on iOS. Carries the full plan text so the card can render a
/// scrollable formatted block, plus the source label (e.g. "claude", "codex").
struct WorkPendingPlanApprovalModel: Identifiable, Hashable {
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

struct WorkPendingModelSelectionModel: Identifiable, Hashable {
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

struct WorkUsageSummary: Hashable {
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
  /// Lifecycle state attached to an authoritative context snapshot.
  var contextState: WorkContextUsageState? = nil
  /// Monotonic runtime sample used to reject late pre-compaction snapshots.
  var contextSampleId: Int? = nil
}

struct WorkContextUsageViewModel: Equatable {
  var provider: String
  var state: WorkContextUsageState = .measured
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

enum WorkContextUsageState: String, Equatable {
  case measured
  case compacting
  case recalculating
  case unknown
}

enum WorkActiveSendMode: String, Equatable {
  case inline
  case queue
  case interrupt
}

/// Hand-mirrored copy of `ACTIVE_TURN_DISPATCH_MODES` in the desktop's
/// `src/shared/types/chat.ts` — iOS cannot import the TS table, so the two are
/// kept in step by hand. Modes are in menu order; the first is the default.
///
/// Claude folds a message into the live query, so it has all three. Codex takes
/// the app-server's `turn/steer` request into the running turn, so it has "send
/// during turn" — but no cancel-and-resend, so it stops there. Cursor has all
/// three too since `@cursor/sdk` 1.0.31 added `Run.steer()`, but its interrupt
/// keeps its own meaning — it cancels the run and resends on the same agent
/// thread — so its button still says "continue". OpenCode's v2 session prompt
/// admits `delivery: "steer"` into the live agent loop, so it also has "send
/// during turn" and no interrupt. Everything else is queue-only,
/// which leaves nothing to pick between, so the picker stays hidden.
struct WorkActiveSendCapability: Equatable {
  let modes: [WorkActiveSendMode]
  let agentLabel: String
  let interruptContinues: Bool

  var defaultMode: WorkActiveSendMode { modes.first ?? .queue }

  /// The atomic active-turn dispatch modes — everything except plain staging.
  /// These are the ones `chat.dispatchSteer` accepts, so they are also the set
  /// the staged-message strip can offer as buttons.
  var atomicDispatchModes: [WorkActiveSendMode] { modes.filter { $0 != .queue } }

  /// Drops `.inline` for a Cursor run that executes in cloud.
  ///
  /// `Run.steer()` is a local-run API: a cloud run implements it and refuses
  /// every call, so offering "Send during turn" there names an action the host
  /// will not perform. The desktop pane withholds the same handler for the same
  /// reason; this is the mobile half of that rule.
  func withholdingInlineIfNeeded(runsInCloud: Bool, provider: String) -> WorkActiveSendCapability {
    guard runsInCloud, providerFamilyKey(provider) == "cursor", modes.contains(.inline) else { return self }
    return WorkActiveSendCapability(
      modes: modes.filter { $0 != .inline },
      agentLabel: agentLabel,
      interruptContinues: interruptContinues
    )
  }

  static func forProvider(_ provider: String) -> WorkActiveSendCapability {
    // Normalized through the same family collapse the rest of Work uses, so a
    // session labelled "claude-code" or "cursor-agent" is not silently demoted
    // to the queue-only default.
    switch providerFamilyKey(provider) {
    case "claude":
      return WorkActiveSendCapability(modes: [.inline, .queue, .interrupt], agentLabel: "Claude", interruptContinues: false)
    case "codex":
      return WorkActiveSendCapability(modes: [.inline, .queue], agentLabel: "Codex", interruptContinues: false)
    case "cursor":
      // Cursor gained `.inline` when `@cursor/sdk` 1.0.31 added `Run.steer()`.
      // `interruptContinues` stays true: its interrupt still cancels the run and
      // resends on the same thread, which Claude's does not.
      //
      // This arm is provider-keyed, matching desktop's table. The cloud
      // carve-out is a SESSION fact, so it lives in
      // `withholdingInlineIfNeeded` and is applied by the caller that knows the
      // session.
      return WorkActiveSendCapability(modes: [.inline, .queue, .interrupt], agentLabel: "Cursor", interruptContinues: true)
    case "opencode":
      // OpenCode's v2 session prompt admits `delivery: "steer"` into the live
      // agent loop. No interrupt: like Codex there is no cancel-and-resend.
      return WorkActiveSendCapability(modes: [.inline, .queue], agentLabel: "OpenCode", interruptContinues: false)
    // The four ACP providers are queue-only in `ACTIVE_TURN_DISPATCH_MODES`,
    // which is what the default arm already gives them. They are listed anyway
    // so the label reads with the provider's name instead of "the agent", and
    // so the next person diffing this table against the TS one sees them here.
    case "qwen":
      return WorkActiveSendCapability(modes: [.queue], agentLabel: "Qwen", interruptContinues: false)
    case "kimi":
      return WorkActiveSendCapability(modes: [.queue], agentLabel: "Kimi", interruptContinues: false)
    case "grok":
      return WorkActiveSendCapability(modes: [.queue], agentLabel: "Grok", interruptContinues: false)
    case "copilot":
      return WorkActiveSendCapability(modes: [.queue], agentLabel: "GitHub Copilot", interruptContinues: false)
    default:
      return WorkActiveSendCapability(modes: [.queue], agentLabel: "the agent", interruptContinues: false)
    }
  }
}

struct WorkQueuedSteerDisposition: Equatable {
  let shortText: String
  let detailText: String
}

/// Shared wording for the staged-message strip and its detail sheet. Keeping
/// the capability decision here prevents the two surfaces from drifting when
/// a provider gains or loses inline steering.
func workQueuedSteerDisposition(
  capability: WorkActiveSendCapability,
  turnActive: Bool
) -> WorkQueuedSteerDisposition {
  guard turnActive else {
    return WorkQueuedSteerDisposition(
      shortText: "after turn",
      detailText: "It sends as soon as \(capability.agentLabel) is ready."
    )
  }
  if capability.modes.contains(.inline) {
    return WorkQueuedSteerDisposition(
      shortText: "sends at next step",
      detailText: "\(capability.agentLabel) picks it up after the current tool step."
    )
  }
  return WorkQueuedSteerDisposition(
    shortText: "sends when turn ends",
    detailText: "\(capability.agentLabel) can't take a message mid-turn, so it sends when this turn ends."
  )
}

/// Work-board columns, as they are written on screen.
///
/// Hand mirror of `WORK_BOARD_COLUMN_LABEL` in
/// `apps/desktop/src/shared/types/chat.ts` (Swift cannot import the TS union).
/// The phone has no board — three columns of cards do not fit a phone — but it
/// still renders the CHAT-side consequence of a drag, and that divider has to
/// read the same words the board header used.
///
/// An unrecognized column falls back to its raw id rather than to a guess: a
/// newer host naming a fifth column should still be legible here.
let workBoardColumnLabels: [String: String] = [
  "needs_you": "Needs you",
  "working": "Working",
  "waiting": "Waiting",
  "done": "Done",
]

func workBoardColumnLabel(_ column: String) -> String {
  let key = column.trimmingCharacters(in: .whitespacesAndNewlines)
  return workBoardColumnLabels[key] ?? key
}

/// Hand mirror of desktop `CTO_LIVE_REDIRECT_PROVIDERS` in
/// `src/shared/types/chat.ts`: the providers a CTO thread may run on, because
/// they can redirect a turn that is already running.
///
/// Deliberately separate from `WorkActiveSendCapability` above, exactly as it is
/// on the desktop. That table governs the composer's staged-message menu; this
/// is the CTO's own eligibility contract, and Cursor qualifies here through
/// interrupt-and-resend despite having no inline channel at all.
let ctoLiveRedirectProviders: [String] = ["claude", "codex", "cursor"]

/// True when `provider` can redirect a turn already in flight, so it is allowed
/// to be the CTO.
func providerSupportsLiveRedirect(_ provider: String) -> Bool {
  ctoLiveRedirectProviders.contains(providerFamilyKey(provider))
}

/// Hand mirror of desktop `chatStopModes.ts`. iOS cannot import the TS table,
/// so the two stay in step by this struct plus `testWorkChatStopCapabilityMirrorsDesktopStopMatrix`.
struct WorkChatStopCapability: Equatable {
  static let modes: [AgentChatStopMode] = [
    .stopOnly,
    .stopAndClear,
    .stopAndBackground,
    .stopAndClearAndBackground,
  ]
  static let defaultMode: AgentChatStopMode = .stopAndClear

  static func copy(mode: AgentChatStopMode, jobCount: Int) -> (title: String, detail: String) {
    let jobs = jobCount == 1 ? "1 job" : "\(max(0, jobCount)) jobs"
    switch mode {
    case .stopOnly:
      return (
        "Turn only",
        "Stop the active turn. Keep queued messages and background jobs."
      )
    case .stopAndClear:
      return (
        "Turn + queue",
        "Stop the active turn and cancel queued messages. Background jobs keep running."
      )
    case .stopAndBackground:
      return (
        "Turn + background (\(jobs))",
        "Stop the active turn and stop \(jobs). Keep queued messages."
      )
    case .stopAndClearAndBackground:
      return (
        "Turn + queue + background (\(jobs))",
        "Stop the active turn, cancel queued messages, and stop \(jobs)."
      )
    }
  }

  static func systemImage(for mode: AgentChatStopMode) -> String {
    switch mode {
    case .stopOnly: return "stop.fill"
    case .stopAndClear: return "trash"
    case .stopAndBackground: return "square.fill"
    case .stopAndClearAndBackground: return "xmark.square.fill"
    }
  }
}

/// Hand mirror of desktop `chatAutoResume.ts` usage-limit opt-out. iOS cannot
/// import the TS predicates, so this struct plus `testWorkUsageLimitOptOut*`
/// keep the parked banner and Don’t-continue action aligned with desktop.
struct WorkUsageLimitOptOut: Equatable {
  static func isPendingAutoResume(_ item: AgentChatScheduledWorkItem) -> Bool {
    guard item.source == "auto_resume_limit" else { return false }
    switch item.status {
    case "done", "completed", "cancelled": return false
    default: return true
    }
  }

  static func shouldShow(
    autoContinueAtUsageLimit: Bool?,
    usageLimitParkedUntil: String?,
    scheduledWork: [AgentChatScheduledWorkItem]?,
    now: Date = Date()
  ) -> Bool {
    if autoContinueAtUsageLimit == false { return false }
    if let parkedUntil = usageLimitParkedUntil,
       let parkedDate = workParsedDate(parkedUntil),
       parkedDate > now {
      return true
    }
    return (scheduledWork ?? []).contains(where: isPendingAutoResume)
  }

  static func pendingSchedule(_ scheduledWork: [AgentChatScheduledWorkItem]?) -> AgentChatScheduledWorkItem? {
    scheduledWork?.first(where: isPendingAutoResume)
  }
}

/// Native Claude Task subagents can be stopped one-at-a-time. Spawned ADE chats
/// use a `chat:` task id and keep their own session stop control.
func workSubagentCanStopTask(_ snapshot: WorkSubagentSnapshot) -> Bool {
  guard snapshot.status == .running else { return false }
  let taskId = snapshot.taskId.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !taskId.isEmpty, !taskId.hasPrefix("chat:") else { return false }
  return true
}

func workSubagentStopLabel(_ snapshot: WorkSubagentSnapshot) -> String {
  let type = snapshot.agentType?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  if !type.isEmpty { return "Stop \(type)" }
  return "Stop \(workSubagentMeaningfulName(snapshot))"
}

func workBackgroundCanStopTask(_ item: WorkScheduledWorkSnapshot) -> Bool {
  item.status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "running"
    && !(item.sourceTaskId?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
}

struct WorkQueueRecoveryModel: Equatable {
  let recoveryId: String
  let messageCount: Int
  let expiresAt: String
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

struct WorkCodexStallContext: Hashable {
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

struct WorkCodexRecoveryReceipt: Hashable {
  let action: String
  let state: String
  let automatic: Bool
  let at: String
  var provider: String? = nil
  var recoveryCount: Int = 0
  var providerNeutral: Bool = false
}

struct WorkCommandCardModel: Identifiable, Hashable {
  let id: String
  let command: String
  let cwd: String
  let output: String
  let status: WorkToolCardStatus
  let timestamp: String
  let exitCode: Int?
  let durationMs: Int?
}

struct WorkFileChangeCardModel: Identifiable, Hashable {
  let id: String
  let path: String
  let diff: String
  let kind: String
  let status: WorkToolCardStatus
  let timestamp: String
}

// MARK: - ade_card

/// Tone vocabulary for the `ade_card` chat primitive. Mirrors `AdeCardTone` in
/// `apps/desktop/src/shared/adeCard.ts` — and, like it, deliberately has NO
/// danger/red member. Failures render amber in ADE chat (the house rule stated
/// at the top of `SubagentActivityCards.tsx`); `workAdeCardTone(from:)` folds
/// any red-ish string an emitter invents into `.warning` so a payload cannot
/// bypass the policy.
enum WorkAdeCardTone: String, Equatable {
  case neutral
  case accent
  case success
  case warning
}

/// Semantic row glyph. Open on the wire; unrecognized values parse to `nil`
/// and the row simply renders without a glyph.
enum WorkAdeCardIcon: String, Equatable {
  case pass
  case fail
  case running
  case queued
  case skipped
  case info
  case file
}

struct WorkAdeCardMetric: Hashable {
  let label: String
  let value: String
  let tone: WorkAdeCardTone
}

struct WorkAdeCardRow: Hashable {
  let icon: WorkAdeCardIcon?
  let text: String
  let detail: String?
  let tone: WorkAdeCardTone
}

struct WorkAdeCardProgress: Hashable {
  let passed: Int
  let failed: Int
  let running: Int
  let queued: Int

  var total: Int {
    max(0, passed) + max(0, failed) + max(0, running) + max(0, queued)
  }
}

struct WorkAdeCardAction: Hashable {
  let id: String
  let label: String
  let isPrimary: Bool
}

/// The `AppNavigationTarget` shapes that have an addressable `ade://` form.
/// Kinds with no URL form (`route`, `files-external`, or anything a newer host
/// invents) parse to `nil`, which degrades the card to fallback text without a
/// link rather than dropping the payload.
enum WorkAdeCardNavTarget: Hashable {
  case session(sessionId: String, laneId: String?)
  case file(path: String, line: Int?, laneId: String?)
  case commit(sha: String, laneId: String?)
  case artifact(artifactId: String)
  case lane(laneId: String)
  case pr(
    repoOwner: String,
    repoName: String,
    prNumber: Int,
    detailTab: PrDetailTab?
  )
  case branch(repoOwner: String, repoName: String, branch: String, prNumber: Int?)
  case linearIssue(issueIdentifier: String, branch: String?)
}

/// One `ade_card` transcript row.
///
/// `id` is the wire `cardId`: identity, not content. A repeat emit with the
/// same id merges into this card (see `buildWorkAdeCards`) instead of appending
/// a second row, so a long-running card stays one chronological entry as it
/// progresses.
struct WorkAdeCardModel: Identifiable, Hashable {
  /// Variants this build knows how to render richly. Anything else degrades to
  /// `fallbackText` + deeplink — that is what makes one wire contract safe to
  /// ship across desktop auto-update, App Store review, and npm.
  static let knownVariants: Set<String> = [
    "proof_artifact",
    "pr_ci",
    "pr_review",
    "pr_merged",
    "pr_merge_ready",
    "pr_conflict",
    "claude_session_quota",
  ]

  let id: String
  let variant: String
  /// `state == "terminal"` on the wire. Live cards show the running treatment.
  let isTerminal: Bool
  let title: String
  let subtitle: String?
  let metrics: [WorkAdeCardMetric]
  let rows: [WorkAdeCardRow]
  let progress: WorkAdeCardProgress?
  let navTarget: WorkAdeCardNavTarget?
  let actions: [WorkAdeCardAction]
  let durationMs: Int?
  let degradedReason: String?
  let isStale: Bool?
  let rowsTruncated: Int?
  /// REQUIRED on the wire; never empty here — the parser substitutes a
  /// generated description when an emitter sends a blank one.
  let fallbackText: String
  let turnId: String?
  /// Timestamp of the FIRST envelope carrying this `cardId`. Updates keep the
  /// card anchored where it entered the conversation instead of hopping to the
  /// bottom on every progress emit. Stamped by `buildWorkAdeCards` from the
  /// envelope, so the decoders that have no envelope context can leave it.
  var timestamp: String = ""

  var isKnownVariant: Bool {
    Self.knownVariants.contains(variant.trimmingCharacters(in: .whitespacesAndNewlines))
  }

  /// Keep in sync with `adeCardIsHiddenAfterDismiss` in `adeCard.ts`.
  var isHiddenAfterDismiss: Bool {
    variant == "claude_session_quota" && isTerminal
  }

  /// Later-wins merge for a repeat emit with the same `cardId`. Collections and
  /// optionals only overwrite when the newer payload actually carries them, so
  /// a terse progress ping cannot erase rows an earlier emit established.
  func merging(_ incoming: WorkAdeCardModel) -> WorkAdeCardModel {
    let incomingProgressTotal = incoming.progress.map {
      $0.passed + $0.failed + $0.running + $0.queued
    } ?? 0
    let existingHasDetail = !metrics.isEmpty
      || !rows.isEmpty
      || progress.map { $0.passed + $0.failed + $0.running + $0.queued > 0 } == true
    let incomingHasDetail = !incoming.metrics.isEmpty
      || !incoming.rows.isEmpty
      || incomingProgressTotal > 0
    let preservesEarlierDetail = existingHasDetail
      && (!incomingHasDetail || incoming.degradedReason != nil)

    return WorkAdeCardModel(
      id: id,
      variant: incoming.variant.isEmpty ? variant : incoming.variant,
      isTerminal: incoming.isTerminal,
      title: incoming.title.isEmpty ? title : incoming.title,
      subtitle: incoming.subtitle ?? subtitle,
      metrics: preservesEarlierDetail && incoming.metrics.isEmpty ? metrics : incoming.metrics,
      rows: preservesEarlierDetail && incoming.rows.isEmpty ? rows : incoming.rows,
      progress: preservesEarlierDetail && incomingProgressTotal == 0 ? progress : incoming.progress,
      navTarget: incoming.navTarget ?? navTarget,
      actions: incoming.actions.isEmpty ? actions : incoming.actions,
      durationMs: incoming.durationMs ?? durationMs,
      degradedReason: incomingHasDetail ? incoming.degradedReason : incoming.degradedReason ?? degradedReason,
      isStale: preservesEarlierDetail
        ? true
        : incomingHasDetail
          ? incoming.isStale ?? false
          : incoming.isStale ?? isStale,
      rowsTruncated: incoming.rowsTruncated ?? rowsTruncated,
      fallbackText: incoming.fallbackText.isEmpty ? fallbackText : incoming.fallbackText,
      turnId: incoming.turnId ?? turnId,
      timestamp: timestamp
    )
  }
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
  /// A run of 2+ consecutive same-source stopped subagent result rows, folded
  /// into one calm attributed card (desktop parity: `subagent_stopped_group`).
  /// Keeps a mass stop from rendering as a wall of identical rows.
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
  /// Generic host/agent-emitted `ade_card`. One row per `cardId`, merged in
  /// place as the card progresses.
  case adeCard(WorkAdeCardModel)
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
  /// Model routing gate: the host asks the user to choose a
  /// provider/model/reasoning tuple before the agent continues.
  case pendingModelSelection(WorkPendingModelSelectionModel)
}

extension WorkTimelinePayload: Hashable {
  /// Content hash for change detection: every field that can change what a card
  /// draws, for every card kind.
  ///
  /// Cards update in place under a stable row id — a tool card goes running →
  /// completed and gains a result, a subagent card gains a summary, a
  /// pending-input card gains a resolution — so a revision built from ids and
  /// timestamps alone leaves the visible cell showing the old content. Hashing
  /// the model itself keeps this aligned with payload equality by construction.
  ///
  /// `.message` is the one case that hashes only its identity here: assistant
  /// markdown is long and re-hashed several times a second during a streaming
  /// turn, so `workChatTranscriptRowRevision` covers messages through the
  /// digest-based fast path instead. Hashing fewer fields than `==` compares is
  /// always safe (it can only collide, never falsely separate).
  func hash(into hasher: inout Hasher) {
    switch self {
    case .message(let message):
      hasher.combine(0)
      hasher.combine(message.id)
    case .toolCard(let model):
      hasher.combine(1)
      hasher.combine(model)
    case .commandCard(let model):
      hasher.combine(2)
      hasher.combine(model)
    case .fileChangeCard(let model):
      hasher.combine(3)
      hasher.combine(model)
    case .subagent(let model):
      hasher.combine(4)
      hasher.combine(model)
    case .subagentStoppedGroup(let model):
      hasher.combine(5)
      hasher.combine(model)
    case .toolGroup(let model):
      hasher.combine(6)
      hasher.combine(model)
    case .changedFiles(let model):
      hasher.combine(7)
      hasher.combine(model)
    case .eventCard(let model):
      hasher.combine(8)
      hasher.combine(model)
    case .adeCard(let model):
      hasher.combine(9)
      hasher.combine(model)
    case .usageSummary(let model):
      hasher.combine(10)
      hasher.combine(model)
    case .artifact(let model):
      hasher.combine(11)
      hasher.combine(model)
    case .turnSeparator(let model):
      hasher.combine(12)
      hasher.combine(model)
    case .turnEndMarker(let model):
      hasher.combine(13)
      hasher.combine(model)
    case .pendingQuestion(let model):
      hasher.combine(14)
      hasher.combine(model)
    case .pendingPermission(let model):
      hasher.combine(15)
      hasher.combine(model)
    case .pendingPlanApproval(let model):
      hasher.combine(16)
      hasher.combine(model)
    case .pendingModelSelection(let model):
      hasher.combine(17)
      hasher.combine(model)
    }
  }
}

struct WorkAssistantMarkdownBlockRenderModel: Identifiable, Equatable {
  let id: String
  let messageId: String
  let turnId: String?
  let itemId: String?
  let block: WorkMarkdownBlock
  /// The one block still receiving deltas. Its renders are throwaway, so they
  /// are kept out of the shared inline-markdown cache.
  var isStreamingTail = false

  static func == (lhs: WorkAssistantMarkdownBlockRenderModel, rhs: WorkAssistantMarkdownBlockRenderModel) -> Bool {
    lhs.id == rhs.id
      && lhs.messageId == rhs.messageId
      && lhs.turnId == rhs.turnId
      && lhs.itemId == rhs.itemId
      && lhs.isStreamingTail == rhs.isStreamingTail
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
  /// Digest of the source message. Lets change detection separate two slices of
  /// two different messages without hashing either slice.
  var sourceDigest: String = ""

  static func == (lhs: WorkAssistantMonospacedRenderModel, rhs: WorkAssistantMonospacedRenderModel) -> Bool {
    lhs.id == rhs.id
      && lhs.messageId == rhs.messageId
      && lhs.turnId == rhs.turnId
      && lhs.itemId == rhs.itemId
      && lhs.sourceDigest == rhs.sourceDigest
      && lhs.text == rhs.text
      && lhs.accessibilityLabel == rhs.accessibilityLabel
  }
}

enum WorkTimelineRenderPayload: Equatable {
  case entry(WorkTimelineEntry)
  case assistantMarkdownBlock(WorkAssistantMarkdownBlockRenderModel)
  case assistantMonospaced(WorkAssistantMonospacedRenderModel)
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
enum WorkToolGroupMember: Hashable, Identifiable {
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

struct WorkToolGroupModel: Identifiable, Hashable {
  let id: String
  let members: [WorkToolGroupMember]

  var count: Int { members.count }
}

/// One file's worth of aggregated diff data inside a `WorkChangedFilesGroupModel`.
/// Stats are summed across every event that touched the same path during the
/// cluster, so a file edited by both an `Edit` tool and a `file_change` event
/// renders as a single row.
struct WorkChangedFileEntry: Identifiable, Hashable {
  let id: String
  let path: String
  let kind: String
  let additions: Int
  let deletions: Int
  let diff: String
  let status: WorkToolCardStatus
}

struct WorkChangedFilesGroupModel: Identifiable, Hashable {
  let id: String
  let files: [WorkChangedFileEntry]

  var count: Int { files.count }
}

struct WorkTurnSeparator: Hashable {
  let time: String
  let provider: String
  let modelLabel: String
  let modelId: String?
}

struct WorkTurnEndMarker: Hashable {
  let turnId: String
  let time: String
  let workedDurationLabel: String
  let status: String
  let terminalReasonLabel: String?
  let provider: String
  let modelLabel: String
  let modelId: String?
  /// This turn ended at a provider usage limit (`apiErrorStatus == 429`, or it
  /// is the turn the host's resume row is anchored to). The footer then reads
  /// one quiet line instead of a red FAILED divider — a limit is a wait, not a
  /// fault of the turn.
  var usageLimitPaused: Bool = false
  /// Usage for a usage-limit turn, folded in from the standalone USAGE row so it
  /// moves behind the footer's details toggle instead of shouting beside it.
  var usage: WorkUsageSummary? = nil
}

func workLatestTurnEndTurnId(in timeline: [WorkTimelineEntry]) -> String? {
  for entry in timeline.reversed() {
    if case .turnEndMarker(let marker) = entry.payload {
      return marker.turnId
    }
  }
  return nil
}

/// Entries that arrived after the most recent turn-end marker — i.e. the rows
/// belonging to the turn currently in flight.
///
/// Position, not `turnId`, is the attribution rule: not every payload carries a
/// turn id, and the marker is itself a timeline row, so "after the last marker"
/// is both cheaper and total. Combined with `isStreamingTurn` it answers the one
/// question every collapsible card asks — "is my turn still going?" — and it
/// answers "no" for the whole transcript when nothing is streaming, which is
/// what makes a reopened chat render entirely collapsed.
func workEntryIdsAfterLatestTurnEnd(in timeline: [WorkTimelineEntry]) -> Set<String> {
  var ids = Set<String>()
  for entry in timeline.reversed() {
    if case .turnEndMarker = entry.payload {
      return ids
    }
    ids.insert(entry.id)
  }
  return ids
}

struct WorkTimelineEntry: Identifiable, Equatable {
  let id: String
  let timestamp: String
  let rank: Int
  let payload: WorkTimelinePayload
}

struct WorkSubagentSnapshot: Identifiable, Hashable {
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
  var spawnKind: AgentChatSpawnKind? = nil
  var parentAgentId: String? = nil
  var spawnDepth: Int? = nil
  var resourceLinks: [AgentChatResourceLink] = []
  /// Who ended this agent's work. Older events omit it; the stopped-group fold
  /// treats that as `unknown` and never claims the user interrupted it.
  var stopSource: String? = nil
  /// Plain-language cause for a non-user stop, when the host supplied one.
  var stopReason: String? = nil
  /// True when a real result arrived before a later stop event.
  var resultLanded: Bool = false
  /// Last progress/activity text observed before the terminal result.
  var lastActivity: String? = nil

  var id: String { taskId }
}

struct WorkSubagentTimelineRow: Identifiable, Hashable {
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

/// Folded run of 2+ same-cause, same-source subagent result rows (desktop
/// parity: `SubagentStoppedGroupEvent`). Carries the original result rows so
/// the card can list each agent's title, last activity, and outcome.
struct WorkSubagentStoppedGroupModel: Identifiable, Hashable {
  /// Why the run stopped. The two causes read differently and must not be
  /// merged: an interrupt is something you did, a usage limit is something that
  /// happened to every agent at once.
  enum Reason: Equatable {
    case interrupted
    case usageLimit
  }

  let id: String
  let rows: [WorkSubagentTimelineRow]
  var reason: Reason = .interrupted
  /// Normalized source (`unknown` when the host omitted `stopSource`).
  var stopSource: String = "unknown"
  /// Shared plain-language cause for a non-user stop.
  var stopReason: String? = nil

  var count: Int { rows.count }

  var headline: String {
    let noun = count == 1 ? "agent" : "agents"
    switch reason {
    case .usageLimit: return "\(count) \(noun) stopped · usage limit"
    case .interrupted:
      if stopSource == "user" {
        return "\(count) \(noun) stopped when you interrupted"
      }
      if let stopReason = stopReason?.trimmingCharacters(in: .whitespacesAndNewlines), !stopReason.isEmpty {
        return "\(count) \(noun) stopped: \(stopReason)"
      }
      return "\(count) \(noun) stopped"
    }
  }
}

/// Status line for an individual stopped result row. A missing source or cause
/// stays deliberately neutral instead of blaming the person reading the chat.
func workSubagentStoppedStatusLine(_ snapshot: WorkSubagentSnapshot) -> String {
  if snapshot.stopSource == "user" {
    return "stopped — interrupted"
  }
  if let stopReason = snapshot.stopReason?.trimmingCharacters(in: .whitespacesAndNewlines), !stopReason.isEmpty {
    return "stopped: \(stopReason)"
  }
  return "stopped"
}

func workSubagentStoppedOutcomeLabel(_ snapshot: WorkSubagentSnapshot) -> String {
  snapshot.resultLanded ? "report landed" : "work lost"
}

struct WorkSubagentSelection: Identifiable, Equatable {
  let taskId: String
  let agentId: String?
  let name: String
  let status: WorkSubagentSnapshot.Status
  let background: Bool

  var id: String { taskId }
}

/// Demote/promote and the composer takeover banner write `spawnKind`. Older
/// hosts advertise `chat.updateSession` but do not apply that field, so the
/// dedicated `chat.setSpawnKind` advertise check is the gate.
func workCanDemoteChatToPeer(
  isChat: Bool,
  spawnKind: AgentChatSpawnKind?,
  parentSessionId: String?,
  hostSupportsSpawnKindUpdate: Bool
) -> Bool {
  guard hostSupportsSpawnKindUpdate, isChat, spawnKind == .subagent else { return false }
  let parent = parentSessionId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  return !parent.isEmpty
}

func workCanPromoteChatToSubagent(
  isChat: Bool,
  spawnKind: AgentChatSpawnKind?,
  parentSessionId: String?,
  hostSupportsSpawnKindUpdate: Bool
) -> Bool {
  guard hostSupportsSpawnKindUpdate, isChat, spawnKind == .peer else { return false }
  let parent = parentSessionId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  return !parent.isEmpty
}

/// Apply a successful spawn-kind or takeover-banner write onto the live
/// summary, falling back to the composer latch when `chatSummary` is nil.
func workApplyingSpawnKindUpdate(
  current: AgentChatSessionSummary?,
  fallback: AgentChatSessionSummary?,
  spawnKind: AgentChatSpawnKind? = nil,
  subagentTakeoverPromptShownAt: String?,
  shownAtFallback: String
) -> AgentChatSessionSummary? {
  guard var summary = current ?? fallback else { return nil }
  if let spawnKind {
    summary.spawnKind = spawnKind
  }
  summary.subagentTakeoverPromptShownAt = subagentTakeoverPromptShownAt ?? shownAtFallback
  return summary
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
  /// Transcript-only view of the pending queue: what the events alone can prove
  /// is open. Drives event-card suppression. Readers that can reach the session
  /// summary should go through `pendingInputQueue.resolved(_:)` instead.
  var pendingInputs: [WorkPendingInputItem]
  /// The same derivation plus the gates swept without a `pending_input_resolved`
  /// receipt, which only the session summary can rescue.
  var pendingInputQueue: WorkPendingInputQueue
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
  var latestMessageAssistantItemId: String?
  var latestTurnEndTurnId: String?
  /// Rows belonging to the turn in flight. Empty once every turn has ended.
  var liveTurnEntryIds: Set<String>
  var timeline: [WorkTimelineEntry]

  static let empty = WorkChatTimelineSnapshot(
    signature: 0,
    pendingInputs: [],
    pendingInputQueue: .empty,
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
    latestMessageAssistantItemId: nil,
    latestTurnEndTurnId: nil,
    liveTurnEntryIds: [],
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

struct WorkEventCardModel: Identifiable, Hashable {
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
  /// Child chat a `spawn_completed` peer notice reports on, resolved once at
  /// card-build time out of the notice's `detail` JSON. Only the adjacency fold
  /// in `collapseConsecutiveSpawnCompletionEntries` reads it — a parent that
  /// spawned a peer gets one notice per sibling turn, and this is the key that
  /// tells two runs apart. `nil` for every other card, including a completion
  /// notice whose detail lost its `spawnCompletion` (old or truncated
  /// transcript): an unidentified completion folds into nothing and keeps its
  /// own row rather than silently absorbing a different child's.
  let spawnCompletionChildId: String?
  let technicalDetail: String?
  let nextAction: String?

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
    diagnosticIntegrationFailures: [AgentChatOptionalIntegrationFailure] = [],
    spawnCompletionChildId: String? = nil,
    technicalDetail: String? = nil,
    nextAction: String? = nil
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
    self.spawnCompletionChildId = spawnCompletionChildId
    self.technicalDetail = technicalDetail
    self.nextAction = nextAction
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
  /// A stored video too large to fetch just to draw a row. It downloads when
  /// the user plays it.
  case videoOnDemand(sizeBytes: Int)
  case remoteURL(URL)
  case text(String)
  case error(String)
}

/// Why an artifact is being loaded. A row or card appearing is `.preview`;
/// only `.play` downloads a video larger than `workArtifactEagerVideoMaxBytes`.
enum WorkArtifactLoadIntent {
  case preview
  case play
}

typealias WorkArtifactLoader = @MainActor (ComputerUseArtifactSummary, WorkArtifactLoadIntent) async -> Void

/// The largest stored video fetched when its row appears: the host's
/// whole-file cap (`MAX_SYNC_ARTIFACT_BYTES`), which bounded every preview
/// load before videos were read in slices.
let workArtifactEagerVideoMaxBytes = 8 * 1024 * 1024

/// A fresh temp file for one load of a stored video. Each load gets its own,
/// so a stale load that deletes its file never deletes the one on screen.
func workArtifactVideoTempURL(artifactId: String, fileExtension: String) -> URL {
  FileManager.default.temporaryDirectory
    .appendingPathComponent("ade-work-artifact-\(artifactId)-\(UUID().uuidString)")
    .appendingPathExtension(fileExtension)
}

/// "34 MB" for the play placeholder.
func workArtifactSizeLabel(_ sizeBytes: Int) -> String {
  ByteCountFormatter.string(fromByteCount: Int64(sizeBytes), countStyle: .file)
}

/// Loads started under one scope stop when the chat view that started them
/// goes away, so a download does not finish into a view that is gone.
@MainActor
final class WorkArtifactLoadScope {
  private(set) var isActive = true
  func end() { isActive = false }
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
  let subagentSpawnKind: AgentChatSpawnKind?
  let subagentParentAgentId: String?
  let subagentSpawnDepth: Int?
  let subagentResourceLinks: [AgentChatResourceLink]
  /// HTTP status attached to an SDK terminal API error on a `done` frame
  /// (notably 429). Kept beside the event for the same reason as the subagent
  /// fields above: the turn footer needs "this turn ended at a usage limit"
  /// without growing `WorkChatEvent.done`'s already-wide associated values.
  let apiErrorStatus: Int?
  /// True when this row decoded from the legacy `subagent.completed` wire type
  /// rather than the canonical `subagent_result`. Both normalize to
  /// `.subagentResult`, so only this flag can tell an old host's duplicate twin
  /// apart from two genuine results for the same agent.
  let isLegacySubagentCompletedFrame: Bool
  /// Optional stop attribution carried by `subagent_result`. Kept beside the
  /// normalized event so older hosts and the raw transcript path can omit it
  /// without changing the broad WorkChatEvent associated-value surface.
  let stopSource: String?
  let stopReason: String?
  /// Size of the stored tool result when this row carries only the head slice
  /// the slim mobile wire sent, nil when the result is complete. Drives the
  /// Result block's on-demand fetch.
  let toolResultFullBytes: Int?
  /// Raw Claude queue lifecycle metadata. `WorkChatEvent` intentionally maps
  /// non-terminal lifecycle frames to no visible card, but pending-steer
  /// derivation still needs the status to clear a staged row when the host
  /// reports `started`/`completed` without a delivered user-message frame.
  let commandLifecycleStatus: String?
  let commandLifecycleSteerId: String?
  /// Byte offset of this row in the host's transcript, when it came off a
  /// `chat_history` page. Lets a "show full result" fetch name the exact
  /// location instead of relying on the host's bounded tail scan.
  let sourceOffset: Int?

  init(
    sessionId: String,
    timestamp: String,
    sequence: Int?,
    event: WorkChatEvent,
    subagentTaskType: String? = nil,
    subagentCommand: String? = nil,
    subagentSpawnKind: AgentChatSpawnKind? = nil,
    subagentParentAgentId: String? = nil,
    subagentSpawnDepth: Int? = nil,
    subagentResourceLinks: [AgentChatResourceLink] = [],
    apiErrorStatus: Int? = nil,
    isLegacySubagentCompletedFrame: Bool = false,
    stopSource: String? = nil,
    stopReason: String? = nil,
    toolResultFullBytes: Int? = nil,
    commandLifecycleStatus: String? = nil,
    commandLifecycleSteerId: String? = nil,
    sourceOffset: Int? = nil
  ) {
    self.sessionId = sessionId
    self.timestamp = timestamp
    self.sequence = sequence
    self.event = event
    self.subagentTaskType = subagentTaskType
    self.subagentCommand = subagentCommand
    self.subagentSpawnKind = subagentSpawnKind
    self.subagentParentAgentId = subagentParentAgentId
    self.subagentSpawnDepth = subagentSpawnDepth
    self.subagentResourceLinks = subagentResourceLinks
    self.apiErrorStatus = apiErrorStatus
    self.isLegacySubagentCompletedFrame = isLegacySubagentCompletedFrame
    self.stopSource = stopSource
    self.stopReason = stopReason
    self.toolResultFullBytes = toolResultFullBytes
    self.commandLifecycleStatus = commandLifecycleStatus
    self.commandLifecycleSteerId = commandLifecycleSteerId
    self.sourceOffset = sourceOffset
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
  /// `title` and `nextAction` carry the host's failure presentation verbatim
  /// when it sent one, and the locally derived copy for the category when it
  /// did not. Both are resolved once, where the event is built.
  case error(message: String, detail: String?, category: String, turnId: String?, title: String, nextAction: String)
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
  /// Generic emittable chat card. One associated value: the whole payload is
  /// carried by `WorkAdeCardModel` so this union member never has to grow when
  /// the wire contract adds a field.
  case adeCard(WorkAdeCardModel)
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
    case .adeCard: return "ade_card"
    case .unknown(let type): return type
    }
  }
}
