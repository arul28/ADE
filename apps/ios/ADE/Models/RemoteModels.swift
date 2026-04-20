import Foundation

struct ConnectionDraft: Codable, Equatable {
  var host: String
  var port: Int
  var authKind: String
  var pairedDeviceId: String?
  var lastRemoteDbVersion: Int
  // Legacy saved-field naming kept for compatibility with existing drafts.
  var lastBrainDeviceId: String?
}

struct HostConnectionProfile: Codable, Equatable {
  var hostIdentity: String?
  var hostName: String?
  var port: Int
  var authKind: String
  var pairedDeviceId: String?
  var lastRemoteDbVersion: Int
  var lastHostDeviceId: String?
  var lastSuccessfulAddress: String?
  var savedAddressCandidates: [String]
  var discoveredLanAddresses: [String]
  var tailscaleAddress: String?
  var updatedAt: String

  init(
    hostIdentity: String? = nil,
    hostName: String? = nil,
    port: Int,
    authKind: String,
    pairedDeviceId: String?,
    lastRemoteDbVersion: Int,
    lastHostDeviceId: String?,
    lastSuccessfulAddress: String?,
    savedAddressCandidates: [String],
    discoveredLanAddresses: [String],
    tailscaleAddress: String?,
    updatedAt: String = ISO8601DateFormatter().string(from: Date())
  ) {
    self.hostIdentity = hostIdentity
    self.hostName = hostName
    self.port = port
    self.authKind = authKind
    self.pairedDeviceId = pairedDeviceId
    self.lastRemoteDbVersion = lastRemoteDbVersion
    self.lastHostDeviceId = lastHostDeviceId
    self.lastSuccessfulAddress = lastSuccessfulAddress
    self.savedAddressCandidates = savedAddressCandidates
    self.discoveredLanAddresses = discoveredLanAddresses
    self.tailscaleAddress = tailscaleAddress
    self.updatedAt = updatedAt
  }

  init(legacy draft: ConnectionDraft) {
    self.init(
      port: draft.port,
      authKind: draft.authKind,
      pairedDeviceId: draft.pairedDeviceId,
      lastRemoteDbVersion: draft.lastRemoteDbVersion,
      lastHostDeviceId: draft.lastBrainDeviceId,
      lastSuccessfulAddress: draft.host,
      savedAddressCandidates: [draft.host],
      discoveredLanAddresses: [],
      tailscaleAddress: nil
    )
  }
}

struct DiscoveredSyncHost: Codable, Equatable, Identifiable {
  var id: String
  var serviceName: String
  var hostName: String
  var hostIdentity: String?
  var port: Int
  var addresses: [String]
  var tailscaleAddress: String?
  var lastResolvedAt: String
}

struct SyncAddressCandidate: Codable, Equatable, Identifiable {
  var id: String { "\(kind):\(host)" }
  var host: String
  var kind: String
}

struct SyncPairingHostIdentity: Codable, Equatable {
  var deviceId: String
  var siteId: String
  var name: String
  var platform: String
  var deviceType: String
}

struct SyncPairingQrPayload: Codable, Equatable {
  var version: Int
  var hostIdentity: SyncPairingHostIdentity
  var port: Int
  var addressCandidates: [SyncAddressCandidate]
}

enum SyncDomain: String, CaseIterable, Hashable {
  case lanes
  case files
  case work
  case prs
}

enum SyncHydrationMessaging {
  static let initialData = "Syncing initial data..."
  static let waitingForProjectData = "Waiting for host to sync project data..."
  static let projectDataTimeout = "Timed out waiting for host to sync project data. Try reconnecting."
}

enum SyncDomainPhase: String, Codable, Equatable {
  case disconnected
  case syncingInitialData
  case hydrating
  case ready
  case failed
}

struct SyncDomainStatus: Equatable {
  var phase: SyncDomainPhase
  var lastError: String?
  var lastHydratedAt: Date?

  static let disconnected = SyncDomainStatus(phase: .disconnected)
}

extension SyncDomainStatus {
  /// Inline notice when the domain is in `.failed` but cached rows may still render (no empty-state card).
  func inlineHydrationFailureNotice(for domain: SyncDomain) -> (title: String, message: String)? {
    guard phase == .failed else { return nil }
    let raw = lastError?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let normalized = raw.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    let message =
      normalized.isEmpty
      ? "Fresh data could not be loaded from the host. Cached content may be outdated until you retry or reconnect."
      : normalized
    let title: String
    switch domain {
    case .lanes:
      title = "Lane hydration failed"
    case .files:
      title = "Files hydration failed"
    case .work:
      title = "Work hydration failed"
    case .prs:
      title = "PR hydration failed"
    }
    return (title, message)
  }
}

struct LaneStatus: Codable, Equatable {
  var dirty: Bool
  var ahead: Int
  var behind: Int
  var remoteBehind: Int
  var rebaseInProgress: Bool
}

enum LaneIcon: String, Codable, Equatable {
  case star
  case flag
  case bolt
  case shield
  case tag
}

struct LaneSummary: Codable, Identifiable, Equatable {
  var id: String
  var name: String
  var description: String?
  var laneType: String
  var baseRef: String
  var branchRef: String
  var worktreePath: String
  var attachedRootPath: String?
  var parentLaneId: String?
  var childCount: Int
  var stackDepth: Int
  var parentStatus: LaneStatus?
  var isEditProtected: Bool
  var status: LaneStatus
  var color: String?
  var icon: LaneIcon?
  var tags: [String]
  var folder: String?
  var createdAt: String
  var archivedAt: String?
  var devicesOpen: [DeviceMarker]?
}

struct DeviceMarker: Codable, Identifiable, Equatable, Hashable {
  var deviceId: String
  var displayName: String
  var platform: String

  var id: String { deviceId }
}

enum RemoteJSONValue: Codable, Equatable {
  case string(String)
  case number(Double)
  case bool(Bool)
  case object([String: RemoteJSONValue])
  case array([RemoteJSONValue])
  case null

  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([String: RemoteJSONValue].self) {
      self = .object(value)
    } else if let value = try? container.decode([RemoteJSONValue].self) {
      self = .array(value)
    } else {
      throw DecodingError.typeMismatch(
        RemoteJSONValue.self,
        DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Unsupported JSON value."),
      )
    }
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .string(let value):
      try container.encode(value)
    case .number(let value):
      try container.encode(value)
    case .bool(let value):
      try container.encode(value)
    case .object(let value):
      try container.encode(value)
    case .array(let value):
      try container.encode(value)
    case .null:
      try container.encodeNil()
    }
  }
}

extension RemoteJSONValue {
  var plainTextValue: String? {
    switch self {
    case .string(let value):
      return value.isEmpty ? nil : value
    case .number(let value):
      return value.rounded() == value ? String(Int(value)) : String(value)
    case .bool(let value):
      return value ? "true" : "false"
    case .object, .array, .null:
      return nil
    }
  }
}

struct LaneRuntimeSummary: Codable, Equatable {
  var bucket: String
  var runningCount: Int
  var awaitingInputCount: Int
  var endedCount: Int
  var sessionCount: Int
}

struct LaneStateSnapshotSummary: Codable, Equatable {
  var laneId: String
  var agentSummary: [String: RemoteJSONValue]?
  var missionSummary: [String: RemoteJSONValue]?
  var updatedAt: String?
}

struct RebaseSuggestion: Codable, Equatable {
  var laneId: String
  var parentLaneId: String
  var parentHeadSha: String
  var behindCount: Int
  var lastSuggestedAt: String
  var deferredUntil: String?
  var dismissedAt: String?
  var hasPr: Bool
}

struct AutoRebaseLaneStatus: Codable, Equatable {
  var laneId: String
  var parentLaneId: String?
  var parentHeadSha: String?
  var state: String
  var updatedAt: String
  var conflictCount: Int
  var message: String?
}

struct ConflictStatus: Codable, Equatable {
  var laneId: String
  var status: String
  var overlappingFileCount: Int
  var peerConflictCount: Int
  var lastPredictedAt: String?
}

struct ConflictOverlapFile: Codable, Equatable, Identifiable {
  var id: String { "\(path):\(conflictType)" }
  var path: String
  var conflictType: String
}

struct ConflictOverlap: Codable, Equatable, Identifiable {
  var id: String { "\(peerId ?? "none"):\(peerName)" }
  var peerId: String?
  var peerName: String
  var files: [ConflictOverlapFile]
  var riskLevel: String
}

struct GitUpstreamSyncStatus: Codable, Equatable {
  var hasUpstream: Bool
  var upstreamRef: String?
  var ahead: Int
  var behind: Int
  var diverged: Bool
  var recommendedAction: String
}

struct GitConflictState: Codable, Equatable {
  var laneId: String
  var kind: String?
  var inProgress: Bool
  var conflictedFiles: [String]
  var canContinue: Bool
  var canAbort: Bool
}

struct GitCommitSummary: Codable, Identifiable, Equatable {
  var id: String { sha }
  var sha: String
  var shortSha: String
  var parents: [String]
  var authorName: String
  var authoredAt: String
  var subject: String
  var pushed: Bool
}

struct GitFileHistoryEntry: Codable, Identifiable, Equatable {
  var id: String { commitSha }
  var commitSha: String
  var shortSha: String
  var authorName: String
  var authoredAt: String
  var subject: String
  var path: String
  var previousPath: String?
  var changeType: String
}

struct GitStashSummary: Codable, Identifiable, Equatable {
  var id: String { ref }
  var ref: String
  var subject: String
  var createdAt: String?
}

struct GitBranchSummary: Codable, Identifiable, Equatable {
  var id: String { name }
  var name: String
  var isCurrent: Bool
  var isRemote: Bool
  var upstream: String?
}

struct GitGenerateCommitMessageResult: Codable, Equatable {
  var message: String
  var model: String?
}

struct FileChange: Codable, Identifiable, Equatable {
  var id: String { path }
  var path: String
  var kind: String
}

struct DiffChanges: Codable, Equatable {
  var unstaged: [FileChange]
  var staged: [FileChange]
}

struct DiffSide: Codable, Equatable {
  var exists: Bool
  var text: String
}

struct FileDiff: Codable, Equatable {
  var path: String
  var mode: String
  var original: DiffSide
  var modified: DiffSide
  var isBinary: Bool?
  var language: String?
}

struct StackChainItem: Codable, Identifiable, Equatable {
  var id: String { laneId }
  var laneId: String
  var laneName: String
  var branchRef: String
  var depth: Int
  var parentLaneId: String?
  var status: LaneStatus
}

struct AgentChatSessionSummary: Codable, Identifiable, Equatable {
  var id: String { sessionId }
  var sessionId: String
  var laneId: String
  var provider: String
  var model: String
  var modelId: String?
  var sessionProfile: String?
  var title: String?
  var goal: String?
  var reasoningEffort: String?
  var executionMode: String?
  var permissionMode: String?
  var interactionMode: String?
  var claudePermissionMode: String?
  var codexApprovalPolicy: String?
  var codexSandbox: String?
  var codexConfigSource: String?
  var opencodePermissionMode: String?
  var cursorModeSnapshot: RemoteJSONValue?
  var cursorModeId: String?
  var cursorConfigValues: [String: RemoteJSONValue]?
  var identityKey: String?
  var surface: String?
  var automationId: String?
  var automationRunId: String?
  var capabilityMode: String?
  var computerUse: RemoteJSONValue?
  var completion: ChatCompletionReport?
  var status: String
  var idleSinceAt: String?
  var startedAt: String
  var endedAt: String?
  var lastActivityAt: String
  var lastOutputPreview: String?
  var summary: String?
  var awaitingInput: Bool?
  var threadId: String?
  var requestedCwd: String?
}

struct AgentChatSession: Codable, Identifiable, Equatable {
  var id: String { sessionId }
  var sessionId: String
  var laneId: String
  var provider: String
  var model: String
  var modelId: String?
  var sessionProfile: String?
  var reasoningEffort: String?
  var executionMode: String?
  var permissionMode: String?
  var interactionMode: String?
  var claudePermissionMode: String?
  var codexApprovalPolicy: String?
  var codexSandbox: String?
  var codexConfigSource: String?
  var opencodePermissionMode: String?
  var cursorModeSnapshot: RemoteJSONValue?
  var cursorModeId: String?
  var cursorConfigValues: [String: RemoteJSONValue]?
  var unifiedPermissionMode: String?
  var identityKey: String?
  var surface: String?
  var automationId: String?
  var automationRunId: String?
  var capabilityMode: String?
  var computerUse: RemoteJSONValue?
  var completion: ChatCompletionReport?
  var status: String
  var idleSinceAt: String?
  var threadId: String?
  var requestedCwd: String?
  var createdAt: String
  var lastActivityAt: String

  enum CodingKeys: String, CodingKey {
    case id
    case sessionId
    case laneId
    case provider
    case model
    case modelId
    case sessionProfile
    case reasoningEffort
    case executionMode
    case permissionMode
    case interactionMode
    case claudePermissionMode
    case codexApprovalPolicy
    case codexSandbox
    case codexConfigSource
    case opencodePermissionMode
    case cursorModeSnapshot
    case cursorModeId
    case cursorConfigValues
    case unifiedPermissionMode
    case identityKey
    case surface
    case automationId
    case automationRunId
    case capabilityMode
    case computerUse
    case completion
    case status
    case idleSinceAt
    case threadId
    case requestedCwd
    case createdAt
    case lastActivityAt
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId)
      ?? container.decode(String.self, forKey: .id)
    laneId = try container.decode(String.self, forKey: .laneId)
    provider = try container.decode(String.self, forKey: .provider)
    model = try container.decode(String.self, forKey: .model)
    modelId = try container.decodeIfPresent(String.self, forKey: .modelId)
    sessionProfile = try container.decodeIfPresent(String.self, forKey: .sessionProfile)
    reasoningEffort = try container.decodeIfPresent(String.self, forKey: .reasoningEffort)
    executionMode = try container.decodeIfPresent(String.self, forKey: .executionMode)
    permissionMode = try container.decodeIfPresent(String.self, forKey: .permissionMode)
    interactionMode = try container.decodeIfPresent(String.self, forKey: .interactionMode)
    claudePermissionMode = try container.decodeIfPresent(String.self, forKey: .claudePermissionMode)
    codexApprovalPolicy = try container.decodeIfPresent(String.self, forKey: .codexApprovalPolicy)
    codexSandbox = try container.decodeIfPresent(String.self, forKey: .codexSandbox)
    codexConfigSource = try container.decodeIfPresent(String.self, forKey: .codexConfigSource)
    opencodePermissionMode = try container.decodeIfPresent(String.self, forKey: .opencodePermissionMode)
    cursorModeSnapshot = try container.decodeIfPresent(RemoteJSONValue.self, forKey: .cursorModeSnapshot)
    cursorModeId = try container.decodeIfPresent(String.self, forKey: .cursorModeId)
    cursorConfigValues = try container.decodeIfPresent([String: RemoteJSONValue].self, forKey: .cursorConfigValues)
    unifiedPermissionMode = try container.decodeIfPresent(String.self, forKey: .unifiedPermissionMode)
    identityKey = try container.decodeIfPresent(String.self, forKey: .identityKey)
    surface = try container.decodeIfPresent(String.self, forKey: .surface)
    automationId = try container.decodeIfPresent(String.self, forKey: .automationId)
    automationRunId = try container.decodeIfPresent(String.self, forKey: .automationRunId)
    capabilityMode = try container.decodeIfPresent(String.self, forKey: .capabilityMode)
    computerUse = try container.decodeIfPresent(RemoteJSONValue.self, forKey: .computerUse)
    completion = try container.decodeIfPresent(ChatCompletionReport.self, forKey: .completion)
    status = try container.decode(String.self, forKey: .status)
    idleSinceAt = try container.decodeIfPresent(String.self, forKey: .idleSinceAt)
    threadId = try container.decodeIfPresent(String.self, forKey: .threadId)
    requestedCwd = try container.decodeIfPresent(String.self, forKey: .requestedCwd)
    createdAt = try container.decode(String.self, forKey: .createdAt)
    lastActivityAt = try container.decodeIfPresent(String.self, forKey: .lastActivityAt) ?? createdAt
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(sessionId, forKey: .sessionId)
    try container.encode(laneId, forKey: .laneId)
    try container.encode(provider, forKey: .provider)
    try container.encode(model, forKey: .model)
    try container.encodeIfPresent(modelId, forKey: .modelId)
    try container.encodeIfPresent(sessionProfile, forKey: .sessionProfile)
    try container.encodeIfPresent(reasoningEffort, forKey: .reasoningEffort)
    try container.encodeIfPresent(executionMode, forKey: .executionMode)
    try container.encodeIfPresent(permissionMode, forKey: .permissionMode)
    try container.encodeIfPresent(interactionMode, forKey: .interactionMode)
    try container.encodeIfPresent(claudePermissionMode, forKey: .claudePermissionMode)
    try container.encodeIfPresent(codexApprovalPolicy, forKey: .codexApprovalPolicy)
    try container.encodeIfPresent(codexSandbox, forKey: .codexSandbox)
    try container.encodeIfPresent(codexConfigSource, forKey: .codexConfigSource)
    try container.encodeIfPresent(opencodePermissionMode, forKey: .opencodePermissionMode)
    try container.encodeIfPresent(cursorModeSnapshot, forKey: .cursorModeSnapshot)
    try container.encodeIfPresent(cursorModeId, forKey: .cursorModeId)
    try container.encodeIfPresent(cursorConfigValues, forKey: .cursorConfigValues)
    try container.encodeIfPresent(unifiedPermissionMode, forKey: .unifiedPermissionMode)
    try container.encodeIfPresent(identityKey, forKey: .identityKey)
    try container.encodeIfPresent(surface, forKey: .surface)
    try container.encodeIfPresent(automationId, forKey: .automationId)
    try container.encodeIfPresent(automationRunId, forKey: .automationRunId)
    try container.encodeIfPresent(capabilityMode, forKey: .capabilityMode)
    try container.encodeIfPresent(computerUse, forKey: .computerUse)
    try container.encodeIfPresent(completion, forKey: .completion)
    try container.encode(status, forKey: .status)
    try container.encodeIfPresent(idleSinceAt, forKey: .idleSinceAt)
    try container.encodeIfPresent(threadId, forKey: .threadId)
    try container.encodeIfPresent(requestedCwd, forKey: .requestedCwd)
    try container.encode(createdAt, forKey: .createdAt)
    try container.encode(lastActivityAt, forKey: .lastActivityAt)
  }
}

struct AgentChatCompletionArtifact: Codable, Equatable {
  var type: String
  var description: String
  var reference: String?
}

struct ChatCompletionReport: Codable, Equatable {
  var timestamp: String
  var summary: String
  var status: String
  var artifacts: [AgentChatCompletionArtifact]?
  var blockerDescription: String?
}

enum AgentChatApprovalDecision: String, Codable, Equatable {
  case accept
  case acceptForSession = "accept_for_session"
  case decline
  case cancel
}

enum AgentChatFileChangeKind: String, Codable, Equatable {
  case create
  case modify
  case delete
}

enum AgentChatTurnStatus: String, Codable, Equatable {
  case started
  case completed
  case interrupted
  case failed
}

enum AgentChatActivityKind: String, Codable, Equatable {
  case thinking
  case working
  case editingFile = "editing_file"
  case runningCommand = "running_command"
  case searching
  case reading
  case toolCalling = "tool_calling"
  case webSearching = "web_searching"
  case spawningAgent = "spawning_agent"
}

enum AgentChatNoticeKind: String, Codable, Equatable {
  case auth
  case rateLimit = "rate_limit"
  case hook
  case filePersist = "file_persist"
  case info
  case memory
  case providerHealth = "provider_health"
  case threadError = "thread_error"
}

enum AgentChatApprovalRequestKind: String, Codable, Equatable {
  case command
  case fileChange = "file_change"
  case toolCall = "tool_call"
}

enum AgentChatSubagentStatus: String, Codable, Equatable {
  case completed
  case failed
  case stopped
}

enum AgentChatTodoStatus: String, Codable, Equatable {
  case pending
  case inProgress = "in_progress"
  case completed
}

enum AgentChatAutoApprovalReviewStatus: String, Codable, Equatable {
  case started
  case completed
}

enum AgentChatContextCompactTrigger: String, Codable, Equatable {
  case manual
  case auto
}

enum AgentChatInputAnswerValue: Equatable {
  case string(String)
  case strings([String])
}

extension AgentChatInputAnswerValue: Codable {
  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if let string = try? container.decode(String.self) {
      self = .string(string)
      return
    }
    if let strings = try? container.decode([String].self) {
      self = .strings(strings)
      return
    }
    throw DecodingError.typeMismatch(
      AgentChatInputAnswerValue.self,
      DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Unsupported chat input answer value.")
    )
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .string(let value):
      try container.encode(value)
    case .strings(let value):
      try container.encode(value)
    }
  }
}

struct AgentChatPlanStep: Codable, Equatable {
  var text: String
  var status: String
}

struct AgentChatStructuredQuestionOption: Codable, Equatable {
  var label: String
  var value: String
}

struct AgentChatTodoItem: Codable, Equatable {
  var id: String
  var description: String
  var status: AgentChatTodoStatus
}

struct AgentChatSubagentUsage: Codable, Equatable {
  var totalTokens: Int?
  var toolUses: Int?
  var durationMs: Int?
}

struct AgentChatTurnUsage: Codable, Equatable {
  var inputTokens: Int?
  var outputTokens: Int?
  var cacheReadTokens: Int?
  var cacheCreationTokens: Int?
}

struct AgentChatEventProvenance: Decodable, Equatable {
  var messageId: String?
  var threadId: String?
  var role: String?
  var targetKind: String?
  var sourceSessionId: String?
  var attemptId: String?
  var stepKey: String?
  var laneId: String?
  var runId: String?
}

struct AgentChatEventEnvelope: Decodable, Identifiable, Equatable {
  var id: String {
    let sequencePart = sequence.map(String.init) ?? timestamp
    return "\(sessionId):\(sequencePart)"
  }

  var sessionId: String
  var timestamp: String
  var event: AgentChatEvent
  var sequence: Int?
  var provenance: AgentChatEventProvenance?
}

struct AgentChatFileRef: Codable, Equatable {
  var path: String
  var type: String
}

enum AgentChatEvent: Decodable, Equatable {
  case userMessage(text: String, attachments: [AgentChatFileRef]?, turnId: String?, steerId: String?, deliveryState: String?, processed: Bool?)
  case text(text: String, messageId: String?, turnId: String?, itemId: String?)
  case toolCall(tool: String, args: RemoteJSONValue, itemId: String, logicalItemId: String?, parentItemId: String?, turnId: String?)
  case toolResult(tool: String, result: RemoteJSONValue, itemId: String, logicalItemId: String?, parentItemId: String?, turnId: String?, status: String?)
  case fileChange(path: String, diff: String, kind: AgentChatFileChangeKind, itemId: String, logicalItemId: String?, turnId: String?, status: String?)
  case command(command: String, cwd: String, output: String, itemId: String, logicalItemId: String?, turnId: String?, exitCode: Int?, durationMs: Int?, status: String)
  case plan(steps: [AgentChatPlanStep], turnId: String?, explanation: String?)
  case reasoning(text: String, turnId: String?, itemId: String?, summaryIndex: Int?)
  case approvalRequest(itemId: String, logicalItemId: String?, kind: AgentChatApprovalRequestKind, description: String, turnId: String?, detail: RemoteJSONValue?)
  case pendingInputResolved(itemId: String, resolution: String, turnId: String?)
  case status(turnStatus: AgentChatTurnStatus, turnId: String?, message: String?)
  case delegationState(contract: RemoteJSONValue, message: String?, turnId: String?)
  case error(message: String, turnId: String?, itemId: String?, errorInfo: RemoteJSONValue?)
  case done(turnId: String, status: AgentChatTurnStatus, model: String?, modelId: String?, usage: AgentChatTurnUsage?, costUsd: Double?)
  case activity(activity: AgentChatActivityKind, detail: String?, turnId: String?)
  case stepBoundary(stepNumber: Int, turnId: String?)
  case todoUpdate(items: [AgentChatTodoItem], turnId: String?)
  case subagentStarted(taskId: String, description: String, background: Bool?, turnId: String?)
  case subagentProgress(taskId: String, description: String?, summary: String, usage: AgentChatSubagentUsage?, lastToolName: String?, turnId: String?)
  case subagentResult(taskId: String, status: AgentChatSubagentStatus, summary: String, usage: AgentChatSubagentUsage?, turnId: String?)
  case structuredQuestion(question: String, options: [AgentChatStructuredQuestionOption]?, itemId: String, turnId: String?)
  case toolUseSummary(summary: String, toolUseIds: [String], turnId: String?)
  case contextCompact(trigger: AgentChatContextCompactTrigger, preTokens: Int?, turnId: String?)
  case systemNotice(noticeKind: AgentChatNoticeKind, message: String, detail: RemoteJSONValue?, turnId: String?, steerId: String?)
  case completionReport(report: ChatCompletionReport, turnId: String?)
  case webSearch(query: String, action: String?, itemId: String, logicalItemId: String?, turnId: String?, status: String)
  case autoApprovalReview(targetItemId: String, reviewStatus: AgentChatAutoApprovalReviewStatus, action: String?, review: String?, turnId: String?)
  case promptSuggestion(suggestion: String, turnId: String?)
  case planText(text: String, turnId: String?, itemId: String?)
  case unknown(type: String)
}

extension AgentChatEvent {
  private enum CodingKeys: String, CodingKey {
    case type
    case text
    case attachments
    case turnId
    case steerId
    case deliveryState
    case processed
    case messageId
    case itemId
    case logicalItemId
    case parentItemId
    case tool
    case args
    case result
    case path
    case diff
    case kind
    case command
    case cwd
    case output
    case exitCode
    case durationMs
    case steps
    case explanation
    case summary
    case summaryIndex
    case description
    case detail
    case turnStatus
    case contract
    case message
    case errorInfo
    case status
    case model
    case modelId
    case usage
    case costUsd
    case activity
    case stepNumber
    case items
    case taskId
    case background
    case lastToolName
    case question
    case options
    case toolUseIds
    case trigger
    case preTokens
    case noticeKind
    case report
    case query
    case action
    case reviewStatus
    case review
    case suggestion
    case targetItemId
    case resolution
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let type = try container.decode(String.self, forKey: .type)

    switch type {
    case "user_message":
      self = .userMessage(
        text: try container.decode(String.self, forKey: .text),
        attachments: try container.decodeIfPresent([AgentChatFileRef].self, forKey: .attachments),
        turnId: try container.decodeIfPresent(String.self, forKey: .turnId),
        steerId: try container.decodeIfPresent(String.self, forKey: .steerId),
        deliveryState: try container.decodeIfPresent(String.self, forKey: .deliveryState),
        processed: try container.decodeIfPresent(Bool.self, forKey: .processed)
      )
    case "text":
      self = .text(
        text: try container.decode(String.self, forKey: .text),
        messageId: try container.decodeIfPresent(String.self, forKey: .messageId),
        turnId: try container.decodeIfPresent(String.self, forKey: .turnId),
        itemId: try container.decodeIfPresent(String.self, forKey: .itemId)
      )
    case "tool_call":
      self = .toolCall(
        tool: try container.decode(String.self, forKey: .tool),
        args: try container.decode(RemoteJSONValue.self, forKey: .args),
        itemId: try container.decode(String.self, forKey: .itemId),
        logicalItemId: try container.decodeIfPresent(String.self, forKey: .logicalItemId),
        parentItemId: try container.decodeIfPresent(String.self, forKey: .parentItemId),
        turnId: try container.decodeIfPresent(String.self, forKey: .turnId)
      )
    case "tool_result":
      self = .toolResult(
        tool: try container.decode(String.self, forKey: .tool),
        result: try container.decode(RemoteJSONValue.self, forKey: .result),
        itemId: try container.decode(String.self, forKey: .itemId),
        logicalItemId: try container.decodeIfPresent(String.self, forKey: .logicalItemId),
        parentItemId: try container.decodeIfPresent(String.self, forKey: .parentItemId),
        turnId: try container.decodeIfPresent(String.self, forKey: .turnId),
        status: try container.decodeIfPresent(String.self, forKey: .status)
      )
    case "file_change":
      self = .fileChange(
        path: try container.decode(String.self, forKey: .path),
        diff: try container.decode(String.self, forKey: .diff),
        kind: try container.decode(AgentChatFileChangeKind.self, forKey: .kind),
        itemId: try container.decode(String.self, forKey: .itemId),
        logicalItemId: try container.decodeIfPresent(String.self, forKey: .logicalItemId),
        turnId: try container.decodeIfPresent(String.self, forKey: .turnId),
        status: try container.decodeIfPresent(String.self, forKey: .status)
      )
    case "command":
      self = .command(
        command: try container.decode(String.self, forKey: .command),
        cwd: try container.decode(String.self, forKey: .cwd),
        output: try container.decode(String.self, forKey: .output),
        itemId: try container.decode(String.self, forKey: .itemId),
        logicalItemId: try container.decodeIfPresent(String.self, forKey: .logicalItemId),
        turnId: try container.decodeIfPresent(String.self, forKey: .turnId),
        exitCode: try container.decodeIfPresent(Int.self, forKey: .exitCode),
        durationMs: try container.decodeIfPresent(Int.self, forKey: .durationMs),
        status: try container.decode(String.self, forKey: .status)
      )
    case "plan":
      self = .plan(
        steps: try container.decode([AgentChatPlanStep].self, forKey: .steps),
        turnId: try container.decodeIfPresent(String.self, forKey: .turnId),
        explanation: try container.decodeIfPresent(String.self, forKey: .explanation)
      )
    case "reasoning":
      self = .reasoning(
        text: try container.decode(String.self, forKey: .text),
        turnId: try container.decodeIfPresent(String.self, forKey: .turnId),
        itemId: try container.decodeIfPresent(String.self, forKey: .itemId),
        summaryIndex: try container.decodeIfPresent(Int.self, forKey: .summaryIndex)
      )
    case "approval_request":
      self = .approvalRequest(
        itemId: try container.decode(String.self, forKey: .itemId),
        logicalItemId: try container.decodeIfPresent(String.self, forKey: .logicalItemId),
        kind: try container.decode(AgentChatApprovalRequestKind.self, forKey: .kind),
        description: try container.decode(String.self, forKey: .description),
        turnId: try container.decodeIfPresent(String.self, forKey: .turnId),
        detail: try container.decodeIfPresent(RemoteJSONValue.self, forKey: .detail)
      )
    case "pending_input_resolved":
      self = .pendingInputResolved(
        itemId: try container.decode(String.self, forKey: .itemId),
        resolution: try container.decode(String.self, forKey: .resolution),
        turnId: try container.decodeIfPresent(String.self, forKey: .turnId)
      )
    case "status":
      self = .status(
        turnStatus: try container.decode(AgentChatTurnStatus.self, forKey: .turnStatus),
        turnId: try container.decodeIfPresent(String.self, forKey: .turnId),
        message: try container.decodeIfPresent(String.self, forKey: .message)
      )
    case "delegation_state":
      self = .delegationState(
        contract: try container.decode(RemoteJSONValue.self, forKey: .contract),
        message: try container.decodeIfPresent(String.self, forKey: .message),
        turnId: try container.decodeIfPresent(String.self, forKey: .turnId)
      )
    case "error":
      self = .error(
        message: try container.decode(String.self, forKey: .message),
        turnId: try container.decodeIfPresent(String.self, forKey: .turnId),
        itemId: try container.decodeIfPresent(String.self, forKey: .itemId),
        errorInfo: try container.decodeIfPresent(RemoteJSONValue.self, forKey: .errorInfo)
      )
    case "done":
      self = .done(
        turnId: try container.decode(String.self, forKey: .turnId),
        status: try container.decode(AgentChatTurnStatus.self, forKey: .status),
        model: try container.decodeIfPresent(String.self, forKey: .model),
        modelId: try container.decodeIfPresent(String.self, forKey: .modelId),
        usage: try container.decodeIfPresent(AgentChatTurnUsage.self, forKey: .usage),
        costUsd: try container.decodeIfPresent(Double.self, forKey: .costUsd)
      )
    case "activity":
      self = .activity(
        activity: try container.decode(AgentChatActivityKind.self, forKey: .activity),
        detail: try container.decodeIfPresent(String.self, forKey: .detail),
        turnId: try container.decodeIfPresent(String.self, forKey: .turnId)
      )
    case "step_boundary":
      self = .stepBoundary(
        stepNumber: try container.decode(Int.self, forKey: .stepNumber),
        turnId: try container.decodeIfPresent(String.self, forKey: .turnId)
      )
    case "todo_update":
      self = .todoUpdate(
        items: try container.decode([AgentChatTodoItem].self, forKey: .items),
        turnId: try container.decodeIfPresent(String.self, forKey: .turnId)
      )
    case "subagent_started":
      self = .subagentStarted(
        taskId: try container.decode(String.self, forKey: .taskId),
        description: try container.decode(String.self, forKey: .description),
        background: try container.decodeIfPresent(Bool.self, forKey: .background),
        turnId: try container.decodeIfPresent(String.self, forKey: .turnId)
      )
    case "subagent_progress":
      self = .subagentProgress(
        taskId: try container.decode(String.self, forKey: .taskId),
        description: try container.decodeIfPresent(String.self, forKey: .description),
        summary: try container.decode(String.self, forKey: .summary),
        usage: try container.decodeIfPresent(AgentChatSubagentUsage.self, forKey: .usage),
        lastToolName: try container.decodeIfPresent(String.self, forKey: .lastToolName),
        turnId: try container.decodeIfPresent(String.self, forKey: .turnId)
      )
    case "subagent_result":
      self = .subagentResult(
        taskId: try container.decode(String.self, forKey: .taskId),
        status: try container.decode(AgentChatSubagentStatus.self, forKey: .status),
        summary: try container.decode(String.self, forKey: .summary),
        usage: try container.decodeIfPresent(AgentChatSubagentUsage.self, forKey: .usage),
        turnId: try container.decodeIfPresent(String.self, forKey: .turnId)
      )
    case "structured_question":
      self = .structuredQuestion(
        question: try container.decode(String.self, forKey: .question),
        options: try container.decodeIfPresent([AgentChatStructuredQuestionOption].self, forKey: .options),
        itemId: try container.decode(String.self, forKey: .itemId),
        turnId: try container.decodeIfPresent(String.self, forKey: .turnId)
      )
    case "tool_use_summary":
      self = .toolUseSummary(
        summary: try container.decode(String.self, forKey: .summary),
        toolUseIds: try container.decode([String].self, forKey: .toolUseIds),
        turnId: try container.decodeIfPresent(String.self, forKey: .turnId)
      )
    case "context_compact":
      self = .contextCompact(
        trigger: try container.decode(AgentChatContextCompactTrigger.self, forKey: .trigger),
        preTokens: try container.decodeIfPresent(Int.self, forKey: .preTokens),
        turnId: try container.decodeIfPresent(String.self, forKey: .turnId)
      )
    case "system_notice":
      self = .systemNotice(
        noticeKind: try container.decode(AgentChatNoticeKind.self, forKey: .noticeKind),
        message: try container.decode(String.self, forKey: .message),
        detail: try container.decodeIfPresent(RemoteJSONValue.self, forKey: .detail),
        turnId: try container.decodeIfPresent(String.self, forKey: .turnId),
        steerId: try container.decodeIfPresent(String.self, forKey: .steerId)
      )
    case "completion_report":
      self = .completionReport(
        report: try container.decode(ChatCompletionReport.self, forKey: .report),
        turnId: try container.decodeIfPresent(String.self, forKey: .turnId)
      )
    case "web_search":
      self = .webSearch(
        query: try container.decode(String.self, forKey: .query),
        action: try container.decodeIfPresent(String.self, forKey: .action),
        itemId: try container.decode(String.self, forKey: .itemId),
        logicalItemId: try container.decodeIfPresent(String.self, forKey: .logicalItemId),
        turnId: try container.decodeIfPresent(String.self, forKey: .turnId),
        status: try container.decode(String.self, forKey: .status)
      )
    case "auto_approval_review":
      self = .autoApprovalReview(
        targetItemId: try container.decode(String.self, forKey: .targetItemId),
        reviewStatus: try container.decode(AgentChatAutoApprovalReviewStatus.self, forKey: .reviewStatus),
        action: try container.decodeIfPresent(String.self, forKey: .action),
        review: try container.decodeIfPresent(String.self, forKey: .review),
        turnId: try container.decodeIfPresent(String.self, forKey: .turnId)
      )
    case "prompt_suggestion":
      self = .promptSuggestion(
        suggestion: try container.decode(String.self, forKey: .suggestion),
        turnId: try container.decodeIfPresent(String.self, forKey: .turnId)
      )
    case "plan_text":
      self = .planText(
        text: try container.decode(String.self, forKey: .text),
        turnId: try container.decodeIfPresent(String.self, forKey: .turnId),
        itemId: try container.decodeIfPresent(String.self, forKey: .itemId)
      )
    default:
      self = .unknown(type: type)
    }
  }

  var typeName: String {
    switch self {
    case .userMessage: return "user_message"
    case .text: return "text"
    case .toolCall: return "tool_call"
    case .toolResult: return "tool_result"
    case .fileChange: return "file_change"
    case .command: return "command"
    case .plan: return "plan"
    case .reasoning: return "reasoning"
    case .approvalRequest: return "approval_request"
    case .pendingInputResolved: return "pending_input_resolved"
    case .status: return "status"
    case .delegationState: return "delegation_state"
    case .error: return "error"
    case .done: return "done"
    case .activity: return "activity"
    case .stepBoundary: return "step_boundary"
    case .todoUpdate: return "todo_update"
    case .subagentStarted: return "subagent_started"
    case .subagentProgress: return "subagent_progress"
    case .subagentResult: return "subagent_result"
    case .structuredQuestion: return "structured_question"
    case .toolUseSummary: return "tool_use_summary"
    case .contextCompact: return "context_compact"
    case .systemNotice: return "system_notice"
    case .completionReport: return "completion_report"
    case .webSearch: return "web_search"
    case .autoApprovalReview: return "auto_approval_review"
    case .promptSuggestion: return "prompt_suggestion"
    case .planText: return "plan_text"
    case .unknown(let type): return type
    }
  }
}

extension AgentChatEvent {
  static func decode(from raw: Any) throws -> AgentChatEvent {
    let data = try adeJSONData(withJSONObject: raw)
    return try JSONDecoder().decode(AgentChatEvent.self, from: data)
  }
}

struct AgentChatSubscriptionRequest: Codable, Equatable {
  var sessionId: String
}

struct SyncChatSubscribeSnapshotPayload: Decodable, Equatable {
  var sessionId: String
  var capturedAt: String
  var truncated: Bool
  var events: [AgentChatEventEnvelope]
}

struct AgentChatSteerRequest: Codable, Equatable {
  var sessionId: String
  var text: String
}

struct AgentChatCancelSteerRequest: Codable, Equatable {
  var sessionId: String
  var steerId: String
}

struct AgentChatEditSteerRequest: Codable, Equatable {
  var sessionId: String
  var steerId: String
  var text: String
}

struct AgentChatInterruptRequest: Codable, Equatable {
  var sessionId: String
}

struct AgentChatResumeRequest: Codable, Equatable {
  var sessionId: String
}

struct AgentChatDisposeRequest: Codable, Equatable {
  var sessionId: String
}

struct AgentChatApproveRequest: Codable, Equatable {
  var sessionId: String
  var itemId: String
  var decision: AgentChatApprovalDecision
  var responseText: String?
}

struct AgentChatRespondToInputRequest: Codable, Equatable {
  var sessionId: String
  var itemId: String
  var decision: AgentChatApprovalDecision?
  var answers: [String: AgentChatInputAnswerValue]?
  var responseText: String?
}

struct AgentChatUpdateSessionRequest: Codable, Equatable {
  var sessionId: String
  var title: String?
  var modelId: String?
  var reasoningEffort: String?
  var permissionMode: String?
  var interactionMode: String?
  var claudePermissionMode: String?
  var codexApprovalPolicy: String?
  var codexSandbox: String?
  var codexConfigSource: String?
  var opencodePermissionMode: String?
  var cursorModeId: String?
  var cursorConfigValues: [String: RemoteJSONValue]?
  var unifiedPermissionMode: String?
  var computerUse: RemoteJSONValue?
  var manuallyNamed: Bool?
}

struct AgentChatTranscriptEntry: Codable, Identifiable, Equatable {
  var id: String { "\(timestamp):\(role)" }
  var role: String
  var text: String
  var timestamp: String
  var turnId: String?
}

struct AgentChatTranscriptResponse: Codable, Equatable {
  var sessionId: String
  var entries: [AgentChatTranscriptEntry]
  var truncated: Bool
  var totalEntries: Int
}

struct AgentChatModelReasoningEffort: Codable, Equatable, Identifiable {
  var id: String { effort }
  var effort: String
  var description: String
}

struct AgentChatModelInfo: Codable, Equatable, Identifiable {
  var id: String
  var displayName: String
  var description: String?
  var isDefault: Bool
  var reasoningEfforts: [AgentChatModelReasoningEffort]?
  var maxThinkingTokens: Int?
  var modelId: String?
  var family: String?
  var supportsReasoning: Bool?
  var supportsTools: Bool?
  var color: String?
}

struct LaneListSnapshot: Codable, Identifiable, Equatable {
  var id: String { lane.id }
  var lane: LaneSummary
  var runtime: LaneRuntimeSummary
  var rebaseSuggestion: RebaseSuggestion?
  var autoRebaseStatus: AutoRebaseLaneStatus?
  var conflictStatus: ConflictStatus?
  var stateSnapshot: LaneStateSnapshotSummary?
  var adoptableAttached: Bool
}

struct LaneDetailPayload: Codable, Equatable {
  var lane: LaneSummary
  var runtime: LaneRuntimeSummary
  var stackChain: [StackChainItem]
  var children: [LaneSummary]
  var stateSnapshot: LaneStateSnapshotSummary?
  var rebaseSuggestion: RebaseSuggestion?
  var autoRebaseStatus: AutoRebaseLaneStatus?
  var conflictStatus: ConflictStatus?
  var overlaps: [ConflictOverlap]
  var syncStatus: GitUpstreamSyncStatus?
  var conflictState: GitConflictState?
  var recentCommits: [GitCommitSummary]
  var diffChanges: DiffChanges?
  var stashes: [GitStashSummary]
  var envInitProgress: LaneEnvInitProgress?
  var sessions: [TerminalSessionSummary]
  var chatSessions: [AgentChatSessionSummary]
}

struct LaneRefreshPayload: Codable, Equatable {
  var refreshedCount: Int
  var lanes: [LaneSummary]
  var snapshots: [LaneListSnapshot]?
}

struct LaneEnvInitStep: Codable, Equatable, Identifiable {
  var id: String { "\(kind):\(label)" }
  var kind: String
  var label: String
  var status: String
  var error: String?
  var durationMs: Int?
}

struct LaneEnvInitProgress: Codable, Equatable {
  var laneId: String
  var steps: [LaneEnvInitStep]
  var startedAt: String
  var completedAt: String?
  var overallStatus: String
}

struct LaneTemplate: Codable, Equatable, Identifiable {
  var id: String
  var name: String
  var description: String?
}

struct SyncRemoteCommandPolicy: Codable, Equatable {
  var viewerAllowed: Bool
  var requiresApproval: Bool?
  var localOnly: Bool?
  var queueable: Bool?
}

struct SyncRemoteCommandDescriptor: Codable, Equatable, Identifiable {
  var id: String { action }
  var action: String
  var policy: SyncRemoteCommandPolicy
}

struct FilesWorkspace: Codable, Identifiable, Equatable {
  var id: String
  var kind: String
  var laneId: String?
  var name: String
  var rootPath: String
  var isReadOnlyByDefault: Bool
  var mobileReadOnly: Bool

  var readOnlyOnMobile: Bool {
    mobileReadOnly || isReadOnlyByDefault
  }

  init(
    id: String,
    kind: String,
    laneId: String?,
    name: String,
    rootPath: String,
    isReadOnlyByDefault: Bool,
    mobileReadOnly: Bool = true
  ) {
    self.id = id
    self.kind = kind
    self.laneId = laneId
    self.name = name
    self.rootPath = rootPath
    self.isReadOnlyByDefault = isReadOnlyByDefault
    self.mobileReadOnly = mobileReadOnly
  }

  private enum CodingKeys: String, CodingKey {
    case id
    case kind
    case laneId
    case name
    case rootPath
    case isReadOnlyByDefault
    case mobileReadOnly
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decode(String.self, forKey: .id)
    kind = try container.decode(String.self, forKey: .kind)
    laneId = try container.decodeIfPresent(String.self, forKey: .laneId)
    name = try container.decode(String.self, forKey: .name)
    rootPath = try container.decode(String.self, forKey: .rootPath)
    isReadOnlyByDefault = try container.decode(Bool.self, forKey: .isReadOnlyByDefault)
    mobileReadOnly = try container.decodeIfPresent(Bool.self, forKey: .mobileReadOnly) ?? true
  }
}

struct FileTreeNode: Codable, Identifiable, Equatable {
  var id: String { path }
  var name: String
  var path: String
  var type: String
  var hasChildren: Bool?
  var children: [FileTreeNode]?
  var changeStatus: String?
  var size: Int?
}

struct SyncFileBlob: Codable, Equatable {
  var path: String
  var size: Int
  var mimeType: String?
  var encoding: String
  var isBinary: Bool
  var content: String
  var languageId: String?
}

struct ComputerUseArtifactSummary: Codable, Identifiable, Equatable {
  var id: String
  var artifactKind: String
  var backendStyle: String
  var backendName: String
  var sourceToolName: String?
  var originalType: String?
  var title: String
  var description: String?
  var uri: String
  var storageKind: String
  var mimeType: String?
  var metadataJson: String?
  var createdAt: String
  var ownerKind: String
  var ownerId: String
  var relation: String
  var reviewState: String?
  var workflowState: String?
  var reviewNote: String?
}

struct ComputerUseArtifactReviewMetadata: Codable, Equatable {
  var reviewState: String?
  var workflowState: String?
  var reviewNote: String?
}

struct TerminalResumeLaunchConfig: Codable, Equatable {
  var permissionMode: String?
  var claudePermissionMode: String?
  var codexApprovalPolicy: String?
  var codexSandbox: String?
  var codexConfigSource: String?
}

struct TerminalResumeMetadata: Codable, Equatable {
  var provider: String
  var targetKind: String
  var targetId: String?
  var launch: TerminalResumeLaunchConfig
  var target: String?
  var permissionMode: String?
}

struct FilesQuickOpenItem: Codable, Identifiable, Equatable {
  var id: String { path }
  var path: String
  var score: Double
}

struct FilesSearchTextMatch: Codable, Identifiable, Equatable {
  var id: String { "\(path):\(line):\(column)" }
  var path: String
  var line: Int
  var column: Int
  var preview: String
}

struct TerminalSessionSummary: Codable, Identifiable, Equatable {
  var id: String
  var laneId: String
  var laneName: String
  var ptyId: String?
  var tracked: Bool
  var pinned: Bool
  var manuallyNamed: Bool?
  var goal: String?
  var toolType: String?
  var title: String
  var status: String
  var startedAt: String
  var endedAt: String?
  var exitCode: Int?
  var transcriptPath: String
  var headShaStart: String?
  var headShaEnd: String?
  var lastOutputPreview: String?
  var summary: String?
  var runtimeState: String
  var resumeCommand: String?
  var resumeMetadata: TerminalResumeMetadata?
  var chatIdleSinceAt: String?
}

struct ProcessReadinessConfig: Codable, Equatable {
  var type: String
  var port: Int?
  var pattern: String?
}

struct ProcessDefinition: Codable, Identifiable, Equatable {
  var id: String
  var name: String
  var command: [String]
  var cwd: String
  var env: [String: String]
  var groupIds: [String]
  var autostart: Bool
  var restart: String
  var gracefulShutdownMs: Int
  var dependsOn: [String]
  var readiness: ProcessReadinessConfig
}

struct ProcessRuntime: Codable, Identifiable, Equatable {
  var id: String { runId }
  var runId: String
  var laneId: String
  var processId: String
  var status: String
  var readiness: String
  var pid: Int?
  var sessionId: String?
  var ptyId: String?
  var startedAt: String?
  var endedAt: String?
  var exitCode: Int?
  var lastExitCode: Int?
  var lastEndedAt: String?
  var uptimeMs: Int?
  var ports: [Int]
  var logPath: String?
  var updatedAt: String
}

struct PrSummary: Codable, Identifiable, Equatable {
  var id: String
  var laneId: String
  var projectId: String
  var repoOwner: String
  var repoName: String
  var githubPrNumber: Int
  var githubUrl: String
  var githubNodeId: String?
  var title: String
  var state: String
  var baseBranch: String
  var headBranch: String
  var checksStatus: String
  var reviewStatus: String
  var additions: Int
  var deletions: Int
  var lastSyncedAt: String?
  var createdAt: String
  var updatedAt: String
}

struct PullRequestListItem: Codable, Identifiable, Equatable {
  var id: String
  var laneId: String
  var laneName: String?
  var projectId: String
  var repoOwner: String
  var repoName: String
  var githubPrNumber: Int
  var githubUrl: String
  var title: String
  var state: String
  var baseBranch: String
  var headBranch: String
  var checksStatus: String
  var reviewStatus: String
  var additions: Int
  var deletions: Int
  var lastSyncedAt: String?
  var createdAt: String
  var updatedAt: String
  var adeKind: String?
  var linkedGroupId: String?
  var linkedGroupType: String?
  var linkedGroupName: String?
  var linkedGroupPosition: Int?
  var linkedGroupCount: Int
  var workflowDisplayState: String?
  var cleanupState: String?
}

struct PrGroupMemberSummary: Codable, Identifiable, Equatable {
  var id: String { prId }
  var groupId: String
  var groupType: String
  var groupName: String?
  var targetBranch: String?
  var prId: String
  var laneId: String
  var laneName: String
  var title: String
  var state: String
  var githubPrNumber: Int
  var githubUrl: String
  var baseBranch: String
  var headBranch: String
  var position: Int
}

struct PullRequestDraftSuggestion: Codable, Equatable {
  var title: String
  var body: String
}

struct PrStatus: Codable, Equatable {
  var prId: String
  var state: String
  var checksStatus: String
  var reviewStatus: String
  var isMergeable: Bool
  var mergeConflicts: Bool
  var behindBaseBy: Int
}

struct PrCheck: Codable, Identifiable, Equatable {
  var id: String { "\(name)-\(detailsUrl ?? "none")" }
  var name: String
  var status: String
  var conclusion: String?
  var detailsUrl: String?
  var startedAt: String?
  var completedAt: String?
}

struct PrReview: Codable, Identifiable, Equatable {
  var id: String { "\(reviewer)-\(submittedAt ?? "pending")" }
  var reviewer: String
  var state: String
  var body: String?
  var submittedAt: String?
}

struct PrComment: Codable, Identifiable, Equatable {
  var id: String
  var author: String
  var body: String?
  var source: String
  var url: String?
  var path: String?
  var line: Int?
  var createdAt: String?
  var updatedAt: String?
}

struct PrFile: Codable, Identifiable, Equatable {
  var id: String { filename }
  var filename: String
  var status: String
  var additions: Int
  var deletions: Int
  var patch: String?
  var previousFilename: String?
}

struct PrDetail: Codable, Equatable {
  var prId: String
  var body: String?
  var assignees: [PrUser]
  var author: PrUser
  var isDraft: Bool
  var labels: [PrLabel]
  var requestedReviewers: [PrUser]
  var milestone: String?
  var linkedIssues: [PrLinkedIssue]
}

struct PrLabel: Codable, Identifiable, Equatable {
  var id: String { name }
  var name: String
  var color: String
  var description: String?
}

struct PrUser: Codable, Identifiable, Equatable {
  var id: String { login }
  var login: String
  var avatarUrl: String?
}

struct PrLinkedIssue: Codable, Identifiable, Equatable {
  var id: Int { number }
  var number: Int
  var title: String
  var state: String
}

struct PullRequestSnapshot: Codable, Equatable {
  var detail: PrDetail?
  var status: PrStatus?
  var checks: [PrCheck]
  var reviews: [PrReview]
  var comments: [PrComment]
  var files: [PrFile]
}

struct GitHubRepoRef: Codable, Equatable {
  var owner: String
  var name: String
  var defaultBranch: String?
}

struct GitHubPrListItem: Codable, Identifiable, Equatable {
  var id: String
  var scope: String
  var repoOwner: String
  var repoName: String
  var githubPrNumber: Int
  var githubUrl: String
  var title: String
  var state: String
  var isDraft: Bool
  var baseBranch: String?
  var headBranch: String?
  var author: String?
  var createdAt: String
  var updatedAt: String
  var linkedPrId: String?
  var linkedGroupId: String?
  var linkedLaneId: String?
  var linkedLaneName: String?
  var adeKind: String?
  var workflowDisplayState: String?
  var cleanupState: String?
  var labels: [PrLabel]
  var isBot: Bool
  var commentCount: Int
}

struct GitHubPrSnapshot: Codable, Equatable {
  var repo: GitHubRepoRef?
  var viewerLogin: String?
  var repoPullRequests: [GitHubPrListItem]
  var externalPullRequests: [GitHubPrListItem]
  var syncedAt: String
}

struct PrReviewThreadComment: Codable, Identifiable, Equatable {
  var id: String
  var author: String
  var authorAvatarUrl: String?
  var body: String?
  var url: String?
  var createdAt: String?
  var updatedAt: String?
}

struct PrReviewThread: Codable, Identifiable, Equatable {
  var id: String
  var isResolved: Bool
  var isOutdated: Bool
  var path: String?
  var line: Int?
  var originalLine: Int?
  var startLine: Int?
  var originalStartLine: Int?
  var diffSide: String?
  var url: String?
  var createdAt: String?
  var updatedAt: String?
  var comments: [PrReviewThreadComment]
}

struct PrActionStep: Codable, Identifiable, Equatable {
  var id: String { "\(number)-\(name)" }
  var name: String
  var status: String
  var conclusion: String?
  var number: Int
  var startedAt: String?
  var completedAt: String?
}

struct PrActionJob: Codable, Identifiable, Equatable {
  var id: Int
  var name: String
  var status: String
  var conclusion: String?
  var startedAt: String?
  var completedAt: String?
  var steps: [PrActionStep]
}

struct PrActionRun: Codable, Identifiable, Equatable {
  var id: Int
  var name: String
  var status: String
  var conclusion: String?
  var headSha: String
  var htmlUrl: String
  var createdAt: String
  var updatedAt: String
  var jobs: [PrActionJob]
}

struct PrActivityEvent: Codable, Identifiable, Equatable {
  var id: String
  var type: String
  var author: String?
  var avatarUrl: String?
  var body: String?
  var timestamp: String
  var metadata: [String: RemoteJSONValue]?
}

struct PrDeployment: Codable, Identifiable, Equatable {
  var id: String
  var environment: String
  var state: String
  var description: String?
  var environmentUrl: String?
  var logUrl: String?
  var sha: String
  var ref: String?
  var creator: String?
  var createdAt: String?
  var updatedAt: String?
}

struct AiReviewSummary: Codable, Equatable {
  var summary: String
  var potentialIssues: [String]
  var recommendations: [String]
  var mergeReadiness: String
}

struct PullRequestSnapshotHydration: Codable, Equatable, Identifiable {
  var id: String { prId }
  var prId: String
  var detail: PrDetail?
  var status: PrStatus?
  var checks: [PrCheck]
  var reviews: [PrReview]
  var comments: [PrComment]
  var files: [PrFile]
  var updatedAt: String?
}

struct PullRequestRefreshPayload: Codable, Equatable {
  var refreshedCount: Int
  var prs: [PrSummary]
  var snapshots: [PullRequestSnapshotHydration]
}

struct IntegrationConflictFile: Codable, Identifiable, Equatable {
  var id: String { "\(path):\(conflictType ?? "none")" }
  var path: String
  var conflictType: String?
  var conflictMarkers: String
  var oursExcerpt: String?
  var theirsExcerpt: String?
  var diffHunk: String?
}

struct IntegrationDiffStat: Codable, Equatable {
  var insertions: Int
  var deletions: Int
  var filesChanged: Int
}

struct IntegrationProposalStep: Codable, Identifiable, Equatable {
  var id: String { laneId }
  var laneId: String
  var laneName: String
  var position: Int
  var outcome: String
  var conflictingFiles: [IntegrationConflictFile]
  var diffStat: IntegrationDiffStat
}

struct IntegrationPairwiseResult: Codable, Identifiable, Equatable {
  var id: String { "\(laneAId):\(laneBId)" }
  var laneAId: String
  var laneAName: String
  var laneBId: String
  var laneBName: String
  var outcome: String
  var conflictingFiles: [IntegrationConflictFile]
}

struct IntegrationLaneSummary: Codable, Identifiable, Equatable {
  var id: String { laneId }
  var laneId: String
  var laneName: String
  var outcome: String
  var commitHash: String
  var commitCount: Int
  var conflictsWith: [String]
  var diffStat: IntegrationDiffStat
}

struct IntegrationLaneSnapshot: Codable, Equatable {
  var headSha: String?
  var dirty: Bool
}

struct IntegrationResolutionState: Codable, Equatable {
  var integrationLaneId: String
  var stepResolutions: [String: String]
  var activeWorkerStepId: String?
  var activeLaneId: String?
  var createdSnapshot: IntegrationLaneSnapshot?
  var currentSnapshot: IntegrationLaneSnapshot?
  var laneChangeStatus: String?
  var updatedAt: String
}

struct IntegrationProposal: Codable, Identifiable, Equatable {
  var id: String { proposalId }
  var proposalId: String
  var sourceLaneIds: [String]
  var baseBranch: String
  var pairwiseResults: [IntegrationPairwiseResult]
  var laneSummaries: [IntegrationLaneSummary]
  var steps: [IntegrationProposalStep]
  var overallOutcome: String
  var createdAt: String
  var title: String?
  var body: String?
  var draft: Bool?
  var integrationLaneName: String?
  var status: String
  var integrationLaneId: String?
  var linkedGroupId: String?
  var linkedPrId: String?
  var workflowDisplayState: String?
  var cleanupState: String?
  var closedAt: String?
  var mergedAt: String?
  var completedAt: String?
  var cleanupDeclinedAt: String?
  var cleanupCompletedAt: String?
  var resolutionState: IntegrationResolutionState?
}

struct QueueAutomationConfig: Codable, Equatable {
  var method: String
  var archiveLane: Bool
  var autoResolve: Bool
  var ciGating: Bool
  var resolverProvider: String?
  var resolverModel: String?
  var reasoningEffort: String?
  var permissionMode: String?
  var confidenceThreshold: Double?
  var originSurface: String?
  var originMissionId: String?
  var originRunId: String?
  var originLabel: String?
}

struct QueueLandingEntry: Codable, Identifiable, Equatable {
  var id: String { prId }
  var prId: String
  var laneId: String
  var laneName: String
  var position: Int
  var state: String
  var prNumber: Int?
  var githubUrl: String?
  var resolvedByAi: Bool?
  var resolverRunId: String?
  var mergeCommitSha: String?
  var waitingOn: String?
  var updatedAt: String?
  var error: String?
}

struct QueueLandingState: Codable, Identifiable, Equatable {
  var id: String { queueId }
  var queueId: String
  var groupId: String
  var groupName: String?
  var targetBranch: String?
  var state: String
  var entries: [QueueLandingEntry]
  var currentPosition: Int
  var activePrId: String?
  var activeResolverRunId: String?
  var lastError: String?
  var waitReason: String?
  var config: QueueAutomationConfig
  var startedAt: String
  var completedAt: String?
  var updatedAt: String
}

struct TerminalSnapshot: Codable, Equatable {
  var sessionId: String
  var transcript: String
  var status: String?
  var runtimeState: String?
  var lastOutputPreview: String?
  var capturedAt: String
}

struct SyncScalarBytes: Codable, Equatable {
  var type: String
  var base64: String
}

enum SyncScalarValue: Codable, Equatable {
  case string(String)
  case number(Double)
  case bytes(SyncScalarBytes)
  case null

  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let stringValue = try? container.decode(String.self) {
      self = .string(stringValue)
    } else if let numberValue = try? container.decode(Double.self) {
      self = .number(numberValue)
    } else if let bytesValue = try? container.decode(SyncScalarBytes.self) {
      self = .bytes(bytesValue)
    } else {
      throw DecodingError.typeMismatch(
        SyncScalarValue.self,
        DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Unsupported sync scalar value."),
      )
    }
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .string(let value):
      try container.encode(value)
    case .number(let value):
      try container.encode(value)
    case .bytes(let value):
      try container.encode(value)
    case .null:
      try container.encodeNil()
    }
  }
}

struct CrsqlChangeRow: Codable, Equatable {
  var table: String
  var pk: SyncScalarValue
  var cid: String
  var val: SyncScalarValue
  var colVersion: Int
  var dbVersion: Int
  var siteId: String
  var cl: Int
  var seq: Int

  private enum CodingKeys: String, CodingKey {
    case table
    case pk
    case cid
    case val
    case colVersion = "col_version"
    case dbVersion = "db_version"
    case siteId = "site_id"
    case cl
    case seq
  }
}

struct SyncChangesetBatchPayload: Codable, Equatable {
  var reason: String
  var fromDbVersion: Int
  var toDbVersion: Int
  var changes: [CrsqlChangeRow]
}

struct ApplyRemoteChangesResult: Equatable {
  var appliedCount: Int
  var dbVersion: Int
  var touchedTables: [String]
  var rebuiltFts: Bool
}

// MARK: - Mobile PR snapshot
//
// Additive mirror of the desktop `PrMobileSnapshot` contract. Decodes the
// payload returned by the `prs.getMobileSnapshot` sync command so the iOS
// PRs surface can render stack visibility, create eligibility, workflow
// cards, and per-PR capability gates from a single fetch.

struct PrStackMember: Codable, Identifiable, Equatable {
  var id: String { laneId }
  var laneId: String
  var laneName: String
  var parentLaneId: String?
  var depth: Int
  var role: String
  var dirty: Bool
  var prId: String?
  var prNumber: Int?
  var prState: String?
  var prTitle: String?
  var baseBranch: String?
  var headBranch: String?
  var checksStatus: String?
  var reviewStatus: String?
}

struct PrStackInfo: Codable, Identifiable, Equatable {
  var id: String { stackId }
  var stackId: String
  var rootLaneId: String
  var members: [PrStackMember]
  var size: Int
  var prCount: Int
}

struct PrActionCapabilities: Codable, Equatable {
  var prId: String
  var canOpenInGithub: Bool
  var canMerge: Bool
  var canClose: Bool
  var canReopen: Bool
  var canRequestReviewers: Bool
  var canRerunChecks: Bool
  var canComment: Bool
  var canUpdateDescription: Bool
  var canDelete: Bool
  var mergeBlockedReason: String?
  var requiresLive: Bool
}

struct PrCreateLaneEligibility: Codable, Identifiable, Equatable {
  var id: String { laneId }
  var laneId: String
  var laneName: String
  var parentLaneId: String?
  var repoOwner: String?
  var repoName: String?
  var defaultBaseBranch: String
  var defaultTitle: String
  var dirty: Bool
  /// Commits on the lane branch not on `defaultBaseBranch` (same signal as desktop lane status `ahead`).
  /// Omitted by older desktop hosts — treat as unknown/zero when decoding legacy snapshots.
  var commitsAheadOfBase: Int?
  var hasExistingPr: Bool
  var canCreate: Bool
  var blockedReason: String?
}

struct PrCreateCapabilities: Codable, Equatable {
  var canCreateAny: Bool
  var defaultBaseBranch: String?
  var lanes: [PrCreateLaneEligibility]
}

struct PrIntegrationWorkflowLane: Codable, Identifiable, Equatable {
  var id: String { laneId }
  var laneId: String
  var laneName: String
  var outcome: String
}

/// Unified mobile workflow card. Exactly one of `queue`, `integration`, or
/// `rebase` payload fields will be populated, matching the desktop
/// discriminated union encoded as `kind`.
struct PrWorkflowCard: Codable, Identifiable, Equatable {
  var id: String
  var kind: String
  // queue
  var queueId: String?
  var groupId: String?
  var groupName: String?
  var targetBranch: String?
  var state: String?
  var activePrId: String?
  var currentPosition: Int?
  var totalEntries: Int?
  var entries: [QueueLandingEntry]?
  var waitReason: String?
  var lastError: String?
  var updatedAt: String?
  // integration
  var proposalId: String?
  var title: String?
  var baseBranch: String?
  var overallOutcome: String?
  var integrationStatus: String?
  var laneCount: Int?
  var conflictLaneCount: Int?
  var lanes: [PrIntegrationWorkflowLane]?
  var workflowDisplayState: String?
  var cleanupState: String?
  var linkedPrId: String?
  var integrationLaneId: String?
  var createdAt: String?
  // rebase
  var laneId: String?
  var laneName: String?
  var behindBy: Int?
  var conflictPredicted: Bool?
  var prId: String?
  var prNumber: Int?
  var dismissedAt: String?
  var deferredUntil: String?

  private enum CodingKeys: String, CodingKey {
    case id
    case kind
    case queueId, groupId, groupName, targetBranch, state, activePrId, currentPosition, totalEntries, entries, waitReason, lastError, updatedAt
    case proposalId, title, baseBranch, overallOutcome
    case integrationStatus = "status"
    case laneCount, conflictLaneCount, lanes, workflowDisplayState, cleanupState, linkedPrId, integrationLaneId, createdAt
    case laneId, laneName, behindBy, conflictPredicted, prId, prNumber, dismissedAt, deferredUntil
  }
}

struct PipelineSettings: Codable, Equatable {
  var autoMerge: Bool
  var mergeMethod: String
  var maxRounds: Int
  var onRebaseNeeded: String
}

struct ConvergenceRoundStat: Codable, Identifiable, Equatable {
  var id: Int { round }
  var round: Int
  var newCount: Int
  var fixedCount: Int
  var dismissedCount: Int
}

struct ConvergenceStatus: Codable, Equatable {
  var currentRound: Int
  var maxRounds: Int
  var issuesPerRound: [ConvergenceRoundStat]
  var totalNew: Int
  var totalFixed: Int
  var totalDismissed: Int
  var totalEscalated: Int
  var totalSentToAgent: Int
  var isConverging: Bool
  var canAutoAdvance: Bool
}

struct ConvergenceRuntimeState: Codable, Equatable {
  var prId: String
  var autoConvergeEnabled: Bool
  var status: String
  var pollerStatus: String
  var currentRound: Int
  var activeSessionId: String?
  var activeLaneId: String?
  var activeHref: String?
  var pauseReason: String?
  var errorMessage: String?
  var lastStartedAt: String?
  var lastPolledAt: String?
  var lastPausedAt: String?
  var lastStoppedAt: String?
  var createdAt: String
  var updatedAt: String
}

struct IssueInventoryItem: Codable, Identifiable, Equatable {
  var id: String
  var prId: String
  var source: String
  var type: String
  var externalId: String
  var state: String
  var round: Int
  var filePath: String?
  var line: Int?
  var severity: String?
  var headline: String
  var body: String?
  var author: String?
  var url: String?
  var dismissReason: String?
  var agentSessionId: String?
  var threadCommentCount: Int?
  var threadLatestCommentId: String?
  var threadLatestCommentAuthor: String?
  var threadLatestCommentAt: String?
  var threadLatestCommentSource: String?
  var createdAt: String
  var updatedAt: String
}

struct IssueInventorySnapshot: Codable, Equatable {
  var prId: String
  var items: [IssueInventoryItem]
  var convergence: ConvergenceStatus
  var runtime: ConvergenceRuntimeState
}

struct CreateIntegrationLaneForProposalResult: Codable, Equatable {
  var integrationLaneId: String
  var mergedCleanLanes: [String]
  var conflictingLanes: [String]
}

struct StartIntegrationResolutionResult: Codable, Equatable {
  var conflictFiles: [String]
  var mergedClean: Bool
  var integrationLaneId: String
}

struct RecheckIntegrationStepResult: Codable, Equatable {
  var resolution: String
  var remainingConflictFiles: [String]
  var allResolved: Bool
  var message: String?
}

struct DeleteIntegrationProposalResult: Codable, Equatable {
  var proposalId: String
  var integrationLaneId: String?
  var deletedIntegrationLane: Bool
}

struct PrMobileSnapshot: Codable, Equatable {
  var generatedAt: String
  var prs: [PrSummary]
  var stacks: [PrStackInfo]
  var capabilities: [String: PrActionCapabilities]
  var createCapabilities: PrCreateCapabilities
  var workflowCards: [PrWorkflowCard]
  var live: Bool
}
