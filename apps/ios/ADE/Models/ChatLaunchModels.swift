import Foundation

// Hand-written mirrors of the chat-launch wire types in
// `apps/desktop/src/shared/types/chatLaunch.ts`.
//
// A launch is a chat started into a lane that does not exist yet. The host
// reserves the chat's session id and the lane id up front, returns at once, and
// then fetches the base, checks out the worktree, applies the default lane
// template, creates the chat and sends the opening message. Every client renders
// the same snapshot, pushed as `chat_launch_event` envelopes and readable on
// demand with `chat.getLaunch` / `chat.listLaunches`.
//
// Decoding is deliberately tolerant: the phone can be older than the host, so an
// unknown enum value falls back to a safe default and every optional field
// defaults when a host omits it. Only `launchId` is required.

enum ChatLaunchKind: String, Codable, Equatable {
  case chat
  case cli

  init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = ChatLaunchKind(rawValue: raw) ?? .chat
  }
}

/// foreground = the launching client opens the chat now; background = it keeps its composer.
enum ChatLaunchMode: String, Codable, Equatable {
  case foreground
  case background

  init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = ChatLaunchMode(rawValue: raw) ?? .foreground
  }
}

/// Stage ids. Kept open (a struct, not an enum) so a stage a newer host invents
/// still renders as a row with its raw id rather than failing the snapshot.
struct ChatLaunchStageId: RawRepresentable, Codable, Hashable {
  let rawValue: String

  init(rawValue: String) {
    self.rawValue = rawValue
  }

  init(from decoder: Decoder) throws {
    rawValue = try decoder.singleValueContainer().decode(String.self)
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }

  static let fetch = ChatLaunchStageId(rawValue: "fetch")
  static let checkout = ChatLaunchStageId(rawValue: "checkout")
  static let environment = ChatLaunchStageId(rawValue: "environment")
  static let agent = ChatLaunchStageId(rawValue: "agent")
}

enum ChatLaunchStageStatus: String, Codable, Equatable {
  case pending
  case running
  case done
  case skipped
  /// Finished, but not the way it was asked to (fetch failed, so the last-known base was used).
  case warning
  case failed

  init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = ChatLaunchStageStatus(rawValue: raw) ?? .pending
  }
}

enum ChatLaunchPhase: String, Codable, Equatable {
  case running
  /// CLI only: the lane is ready and the launching client is starting the CLI session.
  case awaitingClient = "awaiting-client"
  case failed
  case completed
  case cancelled

  init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = ChatLaunchPhase(rawValue: raw) ?? .running
  }
}

struct ChatLaunchStage: Codable, Equatable, Identifiable {
  var id: ChatLaunchStageId
  var status: ChatLaunchStageStatus
  var startedAt: String? = nil
  var endedAt: String? = nil
  /// Only `checkout` reports a real percentage.
  var percent: Double? = nil
  var detail: String? = nil
  var error: String? = nil
  /// `environment` only: the lane-environment steps.
  var steps: [LaneEnvInitStep]? = nil

  init(
    id: ChatLaunchStageId,
    status: ChatLaunchStageStatus,
    startedAt: String? = nil,
    endedAt: String? = nil,
    percent: Double? = nil,
    detail: String? = nil,
    error: String? = nil,
    steps: [LaneEnvInitStep]? = nil
  ) {
    self.id = id
    self.status = status
    self.startedAt = startedAt
    self.endedAt = endedAt
    self.percent = percent
    self.detail = detail
    self.error = error
    self.steps = steps
  }

  private enum CodingKeys: String, CodingKey {
    case id, status, startedAt, endedAt, percent, detail, error, steps
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decode(ChatLaunchStageId.self, forKey: .id)
    status = (try? container.decode(ChatLaunchStageStatus.self, forKey: .status)) ?? .pending
    startedAt = try? container.decodeIfPresent(String.self, forKey: .startedAt)
    endedAt = try? container.decodeIfPresent(String.self, forKey: .endedAt)
    percent = try? container.decodeIfPresent(Double.self, forKey: .percent)
    detail = try? container.decodeIfPresent(String.self, forKey: .detail)
    error = try? container.decodeIfPresent(String.self, forKey: .error)
    // One malformed step must not drop the whole snapshot.
    steps = (try? container.decodeIfPresent([ChatLaunchLossy<LaneEnvInitStep>].self, forKey: .steps))?
      .compactMap(\.value)
  }
}

struct ChatLaunchPrompt: Codable, Equatable {
  var text: String
  var displayText: String? = nil
  var attachments: [AgentChatFileRef] = []

  init(text: String, displayText: String? = nil, attachments: [AgentChatFileRef] = []) {
    self.text = text
    self.displayText = displayText
    self.attachments = attachments
  }

  private enum CodingKeys: String, CodingKey {
    case text, displayText, attachments
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    text = (try? container.decodeIfPresent(String.self, forKey: .text)) ?? ""
    displayText = try? container.decodeIfPresent(String.self, forKey: .displayText)
    attachments = ((try? container.decodeIfPresent([ChatLaunchLossy<AgentChatFileRef>].self, forKey: .attachments)) ?? [])
      .compactMap(\.value)
  }

  /// What the user's bubble shows.
  var bubbleText: String {
    let display = displayText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return display.isEmpty ? text : display
  }
}

/// A message typed into the chat while its lane was still being set up. It
/// stays in `queuedMessages` until the host has delivered it — including after
/// the agent started or the launch completed, when a delivery failed.
struct ChatLaunchQueuedMessage: Codable, Equatable, Identifiable {
  var id: String
  var text: String
  var displayText: String? = nil
  var attachments: [AgentChatFileRef]? = nil
  var createdAt: String
  /// The last delivery failure, nil while it has not failed. The host keeps
  /// retrying; clients show the message as "Couldn't send — retrying".
  var deliveryError: String? = nil

  init(
    id: String,
    text: String,
    displayText: String? = nil,
    attachments: [AgentChatFileRef]? = nil,
    createdAt: String,
    deliveryError: String? = nil
  ) {
    self.id = id
    self.text = text
    self.displayText = displayText
    self.attachments = attachments
    self.createdAt = createdAt
    self.deliveryError = deliveryError
  }

  private enum CodingKeys: String, CodingKey {
    case id, text, displayText, attachments, createdAt, deliveryError
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decode(String.self, forKey: .id)
    text = (try? container.decodeIfPresent(String.self, forKey: .text)) ?? ""
    displayText = try? container.decodeIfPresent(String.self, forKey: .displayText)
    attachments = (try? container.decodeIfPresent([ChatLaunchLossy<AgentChatFileRef>].self, forKey: .attachments))?
      .compactMap(\.value)
    createdAt = (try? container.decodeIfPresent(String.self, forKey: .createdAt)) ?? ""
    let error = (try? container.decodeIfPresent(String.self, forKey: .deliveryError))?
      .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    deliveryError = error.isEmpty ? nil : error
  }

  /// The host tried to deliver this message and failed; it is retrying.
  var deliveryFailed: Bool { deliveryError != nil }

  var bubbleText: String {
    let display = displayText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return display.isEmpty ? text : display
  }
}

struct ChatLaunchSnapshot: Codable, Equatable, Identifiable {
  /// Stable id for the launch. For a chat launch this equals `sessionId`.
  var launchId: String
  var kind: ChatLaunchKind
  var mode: ChatLaunchMode
  /// Reserved up front for a chat launch; null for a CLI launch until the PTY exists.
  var sessionId: String?
  /// Reserved lane id. The lane row exists once `laneCreated` is true.
  var laneId: String
  var laneName: String
  /// True while the lane's AI name is still being generated.
  var laneNaming: Bool
  var branchRef: String?
  /// The ref the lane branches from, e.g. `origin/main`.
  var baseRef: String?
  var worktreePath: String?
  /// Default lane template applied to this lane, if any.
  var templateName: String?
  var title: String
  /// The opening message, shown as the user's bubble before the chat exists.
  var prompt: ChatLaunchPrompt
  var modelId: String?
  var phase: ChatLaunchPhase
  var stages: [ChatLaunchStage]
  /// Failure summary when `phase == .failed`.
  var error: String?
  var laneCreated: Bool
  var sessionCreated: Bool
  /// The agent was started (normally, or early with Start now / Start anyway).
  var agentStarted: Bool
  var queuedMessages: [ChatLaunchQueuedMessage]
  var originClientId: String?
  var startedAt: String
  var endedAt: String?
  var updatedAt: String
  /// Monotonic per launch; clients drop snapshots older than the one they hold.
  var sequence: Int

  var id: String { launchId }

  init(
    launchId: String,
    kind: ChatLaunchKind = .chat,
    mode: ChatLaunchMode = .foreground,
    sessionId: String? = nil,
    laneId: String = "",
    laneName: String = "",
    laneNaming: Bool = false,
    branchRef: String? = nil,
    baseRef: String? = nil,
    worktreePath: String? = nil,
    templateName: String? = nil,
    title: String = "",
    prompt: ChatLaunchPrompt = ChatLaunchPrompt(text: ""),
    modelId: String? = nil,
    phase: ChatLaunchPhase = .running,
    stages: [ChatLaunchStage] = [],
    error: String? = nil,
    laneCreated: Bool = false,
    sessionCreated: Bool = false,
    agentStarted: Bool = false,
    queuedMessages: [ChatLaunchQueuedMessage] = [],
    originClientId: String? = nil,
    startedAt: String = "",
    endedAt: String? = nil,
    updatedAt: String = "",
    sequence: Int = 0
  ) {
    self.launchId = launchId
    self.kind = kind
    self.mode = mode
    self.sessionId = sessionId
    self.laneId = laneId
    self.laneName = laneName
    self.laneNaming = laneNaming
    self.branchRef = branchRef
    self.baseRef = baseRef
    self.worktreePath = worktreePath
    self.templateName = templateName
    self.title = title
    self.prompt = prompt
    self.modelId = modelId
    self.phase = phase
    self.stages = stages
    self.error = error
    self.laneCreated = laneCreated
    self.sessionCreated = sessionCreated
    self.agentStarted = agentStarted
    self.queuedMessages = queuedMessages
    self.originClientId = originClientId
    self.startedAt = startedAt
    self.endedAt = endedAt
    self.updatedAt = updatedAt
    self.sequence = sequence
  }

  private enum CodingKeys: String, CodingKey {
    case launchId, kind, mode, sessionId, laneId, laneName, laneNaming, branchRef, baseRef
    case worktreePath, templateName, title, prompt, modelId, phase, stages, error
    case laneCreated, sessionCreated, agentStarted, queuedMessages, originClientId
    case startedAt, endedAt, updatedAt, sequence
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    launchId = try c.decode(String.self, forKey: .launchId)
    kind = (try? c.decodeIfPresent(ChatLaunchKind.self, forKey: .kind)) ?? .chat
    mode = (try? c.decodeIfPresent(ChatLaunchMode.self, forKey: .mode)) ?? .foreground
    sessionId = try? c.decodeIfPresent(String.self, forKey: .sessionId)
    laneId = (try? c.decodeIfPresent(String.self, forKey: .laneId)) ?? ""
    laneName = (try? c.decodeIfPresent(String.self, forKey: .laneName)) ?? ""
    laneNaming = (try? c.decodeIfPresent(Bool.self, forKey: .laneNaming)) ?? false
    branchRef = try? c.decodeIfPresent(String.self, forKey: .branchRef)
    baseRef = try? c.decodeIfPresent(String.self, forKey: .baseRef)
    worktreePath = try? c.decodeIfPresent(String.self, forKey: .worktreePath)
    templateName = try? c.decodeIfPresent(String.self, forKey: .templateName)
    title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
    prompt = (try? c.decodeIfPresent(ChatLaunchPrompt.self, forKey: .prompt)) ?? ChatLaunchPrompt(text: "")
    modelId = try? c.decodeIfPresent(String.self, forKey: .modelId)
    phase = (try? c.decodeIfPresent(ChatLaunchPhase.self, forKey: .phase)) ?? .running
    stages = ((try? c.decodeIfPresent([ChatLaunchLossy<ChatLaunchStage>].self, forKey: .stages)) ?? [])
      .compactMap(\.value)
    error = try? c.decodeIfPresent(String.self, forKey: .error)
    laneCreated = (try? c.decodeIfPresent(Bool.self, forKey: .laneCreated)) ?? false
    sessionCreated = (try? c.decodeIfPresent(Bool.self, forKey: .sessionCreated)) ?? false
    agentStarted = (try? c.decodeIfPresent(Bool.self, forKey: .agentStarted)) ?? false
    queuedMessages = ((try? c.decodeIfPresent([ChatLaunchLossy<ChatLaunchQueuedMessage>].self, forKey: .queuedMessages)) ?? [])
      .compactMap(\.value)
    originClientId = try? c.decodeIfPresent(String.self, forKey: .originClientId)
    startedAt = (try? c.decodeIfPresent(String.self, forKey: .startedAt)) ?? ""
    endedAt = try? c.decodeIfPresent(String.self, forKey: .endedAt)
    updatedAt = (try? c.decodeIfPresent(String.self, forKey: .updatedAt)) ?? ""
    if let intSequence = try? c.decodeIfPresent(Int.self, forKey: .sequence) {
      sequence = intSequence
    } else if let doubleSequence = try? c.decodeIfPresent(Double.self, forKey: .sequence), doubleSequence.isFinite {
      sequence = Int(doubleSequence)
    } else {
      sequence = 0
    }
  }

  /// The session id the chat runs under. For a chat launch the host reserves
  /// `launchId` as the session id, so fall back to it when the field is absent.
  var chatSessionId: String {
    let trimmed = sessionId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return trimmed.isEmpty ? launchId : trimmed
  }
}

enum ChatLaunchEvent: Equatable {
  case launchUpdated(ChatLaunchSnapshot)
  /// The launch record was dropped (dismissed, or expired after completing).
  case launchRemoved(launchId: String)
}

/// The pushed `chat_launch_event` envelope payload. Accepts the bare
/// `ChatLaunchEvent` (`{type, launch}` / `{type, launchId}`) and the runtime
/// wrapper `{type: "chat_launch_event", event: {...}}`, plus the project scope
/// (`projectId` / `projectRootPath`) the host attaches — on the outer payload
/// or on the wrapped event. Older hosts omit it.
struct ChatLaunchEventEnvelope: Decodable, Equatable {
  let event: ChatLaunchEvent?
  let projectId: String?
  let projectRootPath: String?

  private enum CodingKeys: String, CodingKey {
    case type, launch, launchId, event, projectId, projectRootPath
  }

  init(event: ChatLaunchEvent?, projectId: String? = nil, projectRootPath: String? = nil) {
    self.event = event
    self.projectId = projectId
    self.projectRootPath = projectRootPath
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let outerProjectId = chatLaunchNormalizedScope(try? container.decodeIfPresent(String.self, forKey: .projectId))
    let outerRootPath = chatLaunchNormalizedScope(try? container.decodeIfPresent(String.self, forKey: .projectRootPath))
    if container.contains(.event),
       let nested = try? container.decode(ChatLaunchEventEnvelope.self, forKey: .event) {
      event = nested.event
      projectId = outerProjectId ?? nested.projectId
      projectRootPath = outerRootPath ?? nested.projectRootPath
      return
    }
    projectId = outerProjectId
    projectRootPath = outerRootPath
    let type = (try? container.decodeIfPresent(String.self, forKey: .type)) ?? ""
    switch type {
    case "launch-updated":
      event = (try? container.decode(ChatLaunchSnapshot.self, forKey: .launch)).map(ChatLaunchEvent.launchUpdated)
    case "launch-removed":
      let launchId = (try? container.decodeIfPresent(String.self, forKey: .launchId))?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      event = launchId.isEmpty ? nil : .launchRemoved(launchId: launchId)
    default:
      event = nil
    }
  }
}

/// Decodes an element or yields nil, so one malformed entry does not fail its array.
struct ChatLaunchLossy<Value: Decodable>: Decodable {
  let value: Value?

  init(from decoder: Decoder) throws {
    value = try? Value(from: decoder)
  }
}

/// Session settings for the chat a launch creates: the same fields
/// `chat.create` takes today, minus the lane and session ids the launch owns.
struct ChatLaunchChatConfig: Equatable {
  var provider: String
  var model: String
  var reasoningEffort: String? = nil
  var codexFastMode: Bool? = nil
  var piProfileId: String? = nil
  var piProviderId: String? = nil
  var piModelId: String? = nil
  var permissionMode: String? = nil
  var interactionMode: String? = nil
  var claudePermissionMode: String? = nil
  var codexApprovalPolicy: String? = nil
  var codexSandbox: String? = nil
  var codexConfigSource: String? = nil
  var opencodePermissionMode: String? = nil
  var droidPermissionMode: String? = nil
  var cursorModeId: String? = nil
}

/// Everything a client needs to start a chat launch. `ChatLaunchArgs` on the
/// wire is built from this by `chatLaunchCommandArgs`.
struct ChatLaunchRequest: Equatable {
  /// Lowercase UUID; also the chat's session id.
  let launchId: String
  /// Lowercase UUID for the lane the launch creates.
  let laneId: String
  /// The deterministic auto-lane name shown optimistically; the host creates
  /// the lane under it and renames it once the AI name arrives.
  let laneName: String
  /// The opening message exactly as `chat.send` would get it.
  let prompt: String
  let displayPrompt: String?
  let title: String?
  let chat: ChatLaunchChatConfig
  let projectId: String?
  let projectRootPath: String?
  let originClientId: String?
  var baseBranch: String? = nil
}

/// Whether a new-chat send goes through the host-owned launch
/// (`chat.startLaunch`) rather than the chained lanes.create → chat.create →
/// chat.send flow. One gate for every composer (Work new chat, Hub drawer):
/// only a plain chat into an auto-created lane, never a Cursor Cloud launch
/// (that has its own cloud-agent flow), and only when the host takes it.
func chatLaunchComposerShouldUseLaunch(
  isAutoCreateLane: Bool,
  isChatSession: Bool,
  cursorCloudMode: Bool,
  hostCanStartLaunch: Bool
) -> Bool {
  isAutoCreateLane && isChatSession && !cursorCloudMode && hostCanStartLaunch
}

extension ChatLaunchRequest {
  /// The launch a new-chat composer sends, or nil when the send must take the
  /// chained flow (see `chatLaunchComposerShouldUseLaunch`). Shared by the
  /// Work new-chat screen and the Hub drawer so the gate and the session
  /// settings a launch carries cannot drift between them.
  init?(
    composerOpener opener: String,
    laneName: @autoclosure () -> String,
    provider: String,
    modelId: String,
    reasoningEffort: String,
    codexFastMode: Bool?,
    piMetadata: WorkPiModelMetadata?,
    wire: WorkRuntimeWireFields,
    projectId: String?,
    projectRootPath: String?,
    originClientId: String?,
    isAutoCreateLane: Bool,
    isChatSession: Bool,
    cursorCloudMode: Bool,
    hostCanStartLaunch: Bool
  ) {
    guard chatLaunchComposerShouldUseLaunch(
      isAutoCreateLane: isAutoCreateLane,
      isChatSession: isChatSession,
      cursorCloudMode: cursorCloudMode,
      hostCanStartLaunch: hostCanStartLaunch
    ) else { return nil }
    let reasoning = reasoningEffort.trimmingCharacters(in: .whitespacesAndNewlines)
    self.init(
      launchId: chatLaunchNewId(),
      laneId: chatLaunchNewId(),
      laneName: laneName(),
      prompt: opener,
      displayPrompt: nil,
      title: nil,
      chat: ChatLaunchChatConfig(
        provider: provider,
        model: modelId,
        reasoningEffort: reasoning.isEmpty ? nil : reasoning,
        codexFastMode: codexFastMode,
        piProfileId: piMetadata?.profileId,
        piProviderId: piMetadata?.providerId,
        piModelId: piMetadata?.modelId,
        permissionMode: wire.permissionMode,
        interactionMode: wire.interactionMode,
        claudePermissionMode: wire.claudePermissionMode,
        codexApprovalPolicy: wire.codexApprovalPolicy,
        codexSandbox: wire.codexSandbox,
        codexConfigSource: wire.codexConfigSource,
        opencodePermissionMode: wire.opencodePermissionMode,
        droidPermissionMode: wire.droidPermissionMode,
        cursorModeId: wire.cursorModeId
      ),
      projectId: projectId,
      projectRootPath: projectRootPath,
      originClientId: originClientId
    )
  }
}

/// Builds the `chat.startLaunch` args (`ChatLaunchArgs`). `createArgs` are the
/// `chat.create` args the client sends today; any lane/session id in them is
/// stripped because the launch owns both.
func chatLaunchCommandArgs(
  request: ChatLaunchRequest,
  createArgs: [String: Any],
  attachments: [AgentChatFileRef]
) -> [String: Any] {
  var create = createArgs
  create.removeValue(forKey: "laneId")
  create.removeValue(forKey: "sessionId")

  let attachmentPayload = chatAttachmentArgs(attachments)

  var message: [String: Any] = ["text": request.prompt]
  if let display = request.displayPrompt, !display.isEmpty {
    message["displayText"] = display
  }
  if !attachmentPayload.isEmpty {
    message["attachments"] = attachmentPayload
  }

  var args: [String: Any] = [
    "kind": ChatLaunchKind.chat.rawValue,
    "mode": ChatLaunchMode.foreground.rawValue,
    "launchId": request.launchId,
    "laneId": request.laneId,
    "prompt": request.prompt,
    "chat": ["create": create, "message": message],
  ]
  let laneName = request.laneName.trimmingCharacters(in: .whitespacesAndNewlines)
  if !laneName.isEmpty {
    args["laneName"] = laneName
  }
  if let display = request.displayPrompt, !display.isEmpty {
    args["displayPrompt"] = display
  }
  if !attachmentPayload.isEmpty {
    args["attachments"] = attachmentPayload
  }
  let modelId = request.chat.model.trimmingCharacters(in: .whitespacesAndNewlines)
  if !modelId.isEmpty {
    args["modelId"] = modelId
  }
  let provider = request.chat.provider.trimmingCharacters(in: .whitespacesAndNewlines)
  if !provider.isEmpty {
    args["provider"] = provider
  }
  if let title = request.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty {
    args["title"] = title
  }
  if let origin = request.originClientId, !origin.isEmpty {
    args["originClientId"] = origin
  }
  if let base = request.baseBranch?.trimmingCharacters(in: .whitespacesAndNewlines), !base.isEmpty {
    args["baseBranch"] = base
  }
  return args
}

/// The snapshot a client shows the instant the user hits send, before the host
/// answers. Sequence -1 so the host's first snapshot always wins.
func chatLaunchOptimisticSnapshot(
  request: ChatLaunchRequest,
  now: Date = Date()
) -> ChatLaunchSnapshot {
  let timestamp = chatLaunchTimestampFormatter.string(from: now)
  return ChatLaunchSnapshot(
    launchId: request.launchId,
    kind: .chat,
    mode: .foreground,
    sessionId: request.launchId,
    laneId: request.laneId,
    laneName: request.laneName,
    laneNaming: true,
    title: request.title ?? "",
    prompt: ChatLaunchPrompt(text: request.prompt, displayText: request.displayPrompt, attachments: []),
    modelId: request.chat.model.isEmpty ? nil : request.chat.model,
    phase: .running,
    stages: [
      ChatLaunchStage(id: .fetch, status: .pending),
      ChatLaunchStage(id: .checkout, status: .pending),
      ChatLaunchStage(id: .agent, status: .pending),
    ],
    originClientId: request.originClientId,
    startedAt: timestamp,
    updatedAt: timestamp,
    sequence: -1
  )
}

let chatLaunchTimestampFormatter: ISO8601DateFormatter = {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter
}()

/// A new lowercase UUID for a launch or lane id.
func chatLaunchNewId() -> String {
  UUID().uuidString.lowercased()
}

// MARK: - Pure helpers (shared by services and views)

let chatLaunchStageOrder: [ChatLaunchStageId] = [.fetch, .checkout, .environment, .agent]

func isChatLaunchTerminal(_ phase: ChatLaunchPhase) -> Bool {
  phase == .completed || phase == .cancelled
}

/// A launch still owns the chat's first moments: the thread shows its card, the composer queues.
func isChatLaunchPending(phase: ChatLaunchPhase, agentStarted: Bool) -> Bool {
  !agentStarted && (phase == .running || phase == .failed || phase == .awaitingClient)
}

func isChatLaunchPending(_ launch: ChatLaunchSnapshot) -> Bool {
  isChatLaunchPending(phase: launch.phase, agentStarted: launch.agentStarted)
}

/// Apply an incoming snapshot only if it is newer than the one held.
func mergeChatLaunchSnapshot(
  _ current: ChatLaunchSnapshot?,
  _ next: ChatLaunchSnapshot
) -> ChatLaunchSnapshot {
  guard let current, current.launchId == next.launchId else { return next }
  return next.sequence >= current.sequence ? next : current
}

/// Session id → launch id, for an `ade_card` whose cardId is `lane-setup:<launchId>`.
func chatLaunchIdFromLaneSetupCardId(_ cardId: String) -> String? {
  let prefix = "lane-setup:"
  guard cardId.hasPrefix(prefix) else { return nil }
  let id = String(cardId.dropFirst(prefix.count)).trimmingCharacters(in: .whitespacesAndNewlines)
  return id.isEmpty ? nil : id
}

/// Best-effort provider family for a launch this device did not start (the
/// snapshot carries the model, not the provider). Only used to pick a row
/// glyph until the real session row lands.
func chatLaunchInferredProvider(modelId: String?) -> String {
  let raw = (modelId ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  if raw.isEmpty { return "claude" }
  if raw.hasPrefix("gpt") || raw.contains("codex") || raw.hasPrefix("openai/") || raw.hasPrefix("o3") || raw.hasPrefix("o4") {
    return "codex"
  }
  let family = providerFamilyKey(raw)
  return workNormalizedChatProvider(family)
}

/// A project id / root path with whitespace trimmed, nil when blank.
func chatLaunchNormalizedScope(_ value: String?) -> String? {
  let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  return trimmed.isEmpty ? nil : trimmed
}
