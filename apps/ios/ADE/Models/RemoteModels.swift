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
  /// Internal per-connection DB/runtime identity. Saved machine rows and
  /// keychain tokens are keyed by `hostIdentity`/deviceId; `siteId` is retained
  /// to migrate older runtime-keyed pairings and reconnect to the selected
  /// project port.
  var siteId: String?
  var port: Int
  var authKind: String
  var pairedDeviceId: String?
  var lastRemoteDbVersion: Int
  /// Inbound changeset cursor per host project DB, keyed by that DB's
  /// cr-sqlite site id. A brain hosts one project DB at a time and each has
  /// its own db_version sequence, so the single `lastRemoteDbVersion` is only
  /// valid against the DB it was built from — replaying it against another
  /// project's DB silently skips (or refetches) the whole backlog.
  var remoteDbVersionBySite: [String: Int]?
  var lastHostDeviceId: String?
  var lastSuccessfulAddress: String?
  var savedAddressCandidates: [String]
  var discoveredLanAddresses: [String]
  var tailscaleAddress: String?
  var updatedAt: String

  init(
    hostIdentity: String? = nil,
    hostName: String? = nil,
    siteId: String? = nil,
    port: Int,
    authKind: String,
    pairedDeviceId: String?,
    lastRemoteDbVersion: Int,
    remoteDbVersionBySite: [String: Int]? = nil,
    lastHostDeviceId: String?,
    lastSuccessfulAddress: String?,
    savedAddressCandidates: [String],
    discoveredLanAddresses: [String],
    tailscaleAddress: String?,
    updatedAt: String = ISO8601DateFormatter().string(from: Date())
  ) {
    self.hostIdentity = hostIdentity
    self.hostName = hostName
    self.siteId = siteId
    self.port = port
    self.authKind = authKind
    self.pairedDeviceId = pairedDeviceId
    self.lastRemoteDbVersion = lastRemoteDbVersion
    self.remoteDbVersionBySite = remoteDbVersionBySite
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

struct MobileProjectSummary: Codable, Equatable, Identifiable {
  var id: String
  var displayName: String
  var rootPath: String?
  var defaultBaseRef: String?
  var lastOpenedAt: String?
  var iconDataUrl: String?
  var laneCount: Int
  var isAvailable: Bool
  var isCached: Bool
  var isOpen: Bool?

  init(
    id: String,
    displayName: String,
    rootPath: String? = nil,
    defaultBaseRef: String? = nil,
    lastOpenedAt: String? = nil,
    iconDataUrl: String? = nil,
    laneCount: Int,
    isAvailable: Bool,
    isCached: Bool,
    isOpen: Bool? = nil
  ) {
    self.id = id
    self.displayName = displayName
    self.rootPath = rootPath
    self.defaultBaseRef = defaultBaseRef
    self.lastOpenedAt = lastOpenedAt
    self.iconDataUrl = iconDataUrl
    self.laneCount = laneCount
    self.isAvailable = isAvailable
    self.isCached = isCached
    self.isOpen = isOpen
  }
}

struct MobileProjectCatalogPayload: Codable, Equatable {
  var projects: [MobileProjectSummary]
}

struct MobileProjectCatalogChunkPayload: Codable, Equatable {
  var catalogId: String
  var index: Int
  var total: Int
  var done: Bool
  var projects: [MobileProjectSummary]
}

struct MobileProjectConnectionPayload: Codable, Equatable {
  var authKind: String
  var token: String?
  var pairedDeviceId: String?
  var hostIdentity: SyncPairingHostIdentity
  var port: Int
  var addressCandidates: [SyncAddressCandidate]
}

struct MobileProjectSwitchResultPayload: Codable, Equatable {
  var ok: Bool
  var message: String?
  var project: MobileProjectSummary?
  var connection: MobileProjectConnectionPayload?
}

struct DiscoveredSyncHost: Codable, Equatable, Identifiable {
  var id: String
  var serviceName: String
  var hostName: String
  var hostIdentity: String?
  /// Internal per-connection DB/runtime identity advertised in Bonjour TXT.
  /// The primary user-facing identity is `hostIdentity`/deviceId, so multiple
  /// project ports from one machine collapse into one machine row.
  var siteId: String? = nil
  var port: Int
  var addresses: [String]
  var tailscaleAddress: String?
  /// Optional brain label advertised in Bonjour TXT (`runtimeName`).
  var runtimeName: String? = nil
  var runtimeKind: String? = nil
  var runtimeVersion: String? = nil
  var projectIds: [String] = []
  var projectNames: [String] = []
  var projectCount: Int? = nil
  /// Whether the machine advertises that a pairing PIN is already configured.
  /// Sourced from the Bonjour TXT key `pairingPinConfigured`. `nil` means the
  /// machine did not advertise the key (older host) — fall back to the reactive
  /// `pin_not_set` pairing error in that case.
  var pairingPinConfigured: Bool? = nil
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

enum SyncDomain: String, CaseIterable, Hashable {
  case lanes
  case files
  case work
  case prs
}

enum SyncHydrationMessaging {
  static let initialData = "Syncing initial data..."
  static let waitingForProjectData = "Waiting for the machine to sync project data..."
  static let projectDataTimeout = "Timed out waiting for the machine to sync project data. Try reconnecting."
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

struct LaneLinearIssue: Codable, Identifiable, Equatable, Hashable {
  var id: String
  var identifier: String
  var title: String
  var description: String?
  var url: String?
  var projectId: String?
  var projectSlug: String?
  var projectName: String?
  var teamId: String?
  var teamKey: String?
  var teamName: String?
  var stateId: String?
  var stateName: String?
  var stateType: String?
  var priority: Int?
  var priorityLabel: String?
  var labels: [String]?
  var assigneeId: String?
  var assigneeName: String?
  var creatorId: String?
  var creatorName: String?
  var dueDate: String?
  var estimate: Double?
  var branchName: String?
  var createdAt: String?
  var updatedAt: String?
}

struct LaneLinearIssueLinkEvidence: Codable, Equatable, Hashable {
  var chatSessionId: String?
  var commitSha: String?
  var prId: String?
}

struct LaneLinearIssueLink: Codable, Identifiable, Equatable, Hashable {
  var id: String
  var laneId: String
  var issue: LaneLinearIssue
  var role: String
  var source: String
  var includeInPr: Bool
  var closeOnMerge: Bool
  var evidence: LaneLinearIssueLinkEvidence?
  var createdAt: String
  var updatedAt: String
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
  var runtimePlacement: String?
  var linearIssue: LaneLinearIssue?
  var linearIssueLinks: [LaneLinearIssueLink]?
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
  var updatedAt: String?
}

public struct RebaseTargetCommit: Codable, Equatable, Identifiable {
  public var id: String { sha }
  public var sha: String
  public var shortSha: String
  public var subject: String
  public var author: String
  public var committedAt: String

  public init(sha: String, shortSha: String, subject: String, author: String, committedAt: String) {
    self.sha = sha
    self.shortSha = shortSha
    self.subject = subject
    self.author = author
    self.committedAt = committedAt
  }
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
  /// Commits the rebase would pull in. Optional so older hosts and legacy
  /// snapshots continue to decode cleanly.
  var targetCommits: [RebaseTargetCommit]? = nil
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
  var ownedByLaneId: String?
  var ownedByLaneName: String?
  var profiledInCurrentLane: Bool?
  var hasOpenPr: Bool?
}

struct LaneBranchActiveWorkItem: Codable, Identifiable, Equatable {
  var id: String
  var kind: String
  var title: String
  var status: String
}

struct LaneBranchProfile: Codable, Identifiable, Equatable {
  var id: String
  var laneId: String
  var branchRef: String
  var baseRef: String
  var parentLaneId: String?
  var sourceBranchRef: String?
  var createdAt: String
  var updatedAt: String
  var lastCheckedOutAt: String?
}

struct LaneBranchSwitchPreview: Codable, Equatable {
  var laneId: String
  var currentBranchRef: String
  var targetBranchRef: String
  var mode: String
  var dirty: Bool
  var duplicateLaneId: String?
  var duplicateLaneName: String?
  var activeWork: [LaneBranchActiveWorkItem]
  var targetProfile: LaneBranchProfile?
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
  var size: Int?
  var isTruncated: Bool?
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
  var codexFastMode: Bool?
  var executionMode: String?
  var permissionMode: String?
  var interactionMode: String?
  var claudePermissionMode: String?
  var codexApprovalPolicy: String?
  var codexSandbox: String?
  var codexConfigSource: String?
  var opencodePermissionMode: String?
  var droidPermissionMode: String?
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
  var archivedAt: String?
  var lastActivityAt: String
  var lastOutputPreview: String?
  var summary: String?
  var awaitingInput: Bool?
  var pendingInputItemId: String? = nil
  var threadId: String?
  var requestedCwd: String?
  // Orchestration-mode fields (populated when session is part of an orchestration run)
  var orchestrationRunId: String? = nil
  var orchestrationRole: String? = nil
  var orchestrationParentSessionId: String? = nil
  var orchestrationTag: String? = nil
  var orchestrationStepId: String? = nil
  var orchestrationBundlePath: String? = nil
}

struct CtoWorkerEntry: Codable, Identifiable, Hashable {
  let agentId: String
  let name: String
  let avatarSeed: String?
  let status: String
  let sessionSummary: AgentChatSessionSummary?
  var id: String { agentId }

  func hash(into hasher: inout Hasher) {
    hasher.combine(agentId)
    hasher.combine(name)
    hasher.combine(avatarSeed)
    hasher.combine(status)
    hasher.combine(sessionSummary?.sessionId)
  }

  static func == (lhs: CtoWorkerEntry, rhs: CtoWorkerEntry) -> Bool {
    lhs.agentId == rhs.agentId
      && lhs.name == rhs.name
      && lhs.avatarSeed == rhs.avatarSeed
      && lhs.status == rhs.status
      && lhs.sessionSummary?.sessionId == rhs.sessionSummary?.sessionId
  }
}

struct CtoRoster: Codable, Hashable {
  let cto: AgentChatSessionSummary?
  let workers: [CtoWorkerEntry]

  func hash(into hasher: inout Hasher) {
    hasher.combine(cto?.sessionSummary())
    hasher.combine(workers)
  }

  static func == (lhs: CtoRoster, rhs: CtoRoster) -> Bool {
    lhs.cto == rhs.cto && lhs.workers == rhs.workers
  }
}

private extension AgentChatSessionSummary {
  /// Stable identity tuple for hashing contexts where full Hashable is unavailable
  /// (e.g. nested `RemoteJSONValue` fields only conform to Equatable).
  func sessionSummary() -> String {
    "\(sessionId)|\(status)|\(lastActivityAt)"
  }
}

// MARK: - CTO + Worker Agent Models (sync wire types)
//
// Field names mirror the desktop canonical types defined in
// apps/desktop/src/shared/types/{cto,agents,linearSync}.ts. All status-ish
// fields come through as plain `String` so unknown server values don't break
// decoding (e.g. a future "deferred" run state).

// MARK: CTO identity

struct CtoModelPreferences: Codable, Hashable {
  var provider: String
  var model: String
  var reasoningEffort: String?
}

struct CtoCommunicationStyle: Codable, Hashable {
  var verbosity: String
  var proactivity: String
  var escalationThreshold: String
}

/// Mirrors desktop `CtoIdentity`. The server has no top-level `id`; we
/// derive one from `name` for SwiftUI Identifiable semantics.
struct CtoIdentity: Codable, Hashable, Identifiable {
  var id: String { name }
  var name: String
  var version: Int?
  var persona: String?
  var personality: String?
  var customPersonality: String?
  var communicationStyle: CtoCommunicationStyle?
  var constraints: [String]?
  var systemPromptExtension: String?
  var modelPreferences: CtoModelPreferences
  var updatedAt: String?

  /// Flat accessor used by UI code.
  var provider: String { modelPreferences.provider }
  /// Flat accessor used by UI code.
  var model: String { modelPreferences.model }
  /// Flat accessor used by UI code.
  var reasoningEffort: String? { modelPreferences.reasoningEffort }
}

/// Patch sent to `cto.updateIdentity`. Nested `modelPreferences` so the
/// desktop can merge cleanly.
struct CtoIdentityPatch: Codable, Hashable {
  var name: String?
  var personality: String?
  var customPersonality: String?
  var communicationStyle: CtoCommunicationStyle?
  var constraints: [String]?
  var systemPromptExtension: String?
  var modelPreferences: CtoModelPreferences?
}

/// Mirrors desktop `CtoSessionLogEntry`.
struct CtoRecentSession: Codable, Hashable, Identifiable {
  var id: String
  var sessionId: String
  var summary: String
  var startedAt: String
  var endedAt: String?
  var provider: String?
  var modelId: String?
  var capabilityMode: String?
  var createdAt: String?
}

/// Mirrors desktop `CtoSnapshot`.
struct CtoSnapshot: Codable, Hashable {
  var identity: CtoIdentity
  var recentSessions: [CtoRecentSession]?
}

// MARK: Worker agents

/// Subset of desktop `AgentAdapterConfig` — only the fields the mobile UI
/// actually surfaces. Adapter-specific payloads land under free-form keys;
/// we just pull out `provider`/`model` heuristically.
struct AgentAdapterConfig: Codable, Hashable {
  var provider: String?
  var model: String?
  var modelId: String?

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: DynamicKey.self)
    let keyNames = Set(c.allKeys.map(\.stringValue))
    provider = keyNames.contains("provider")
      ? try c.decodeIfPresent(String.self, forKey: DynamicKey(stringValue: "provider")!)
      : nil
    model = keyNames.contains("model")
      ? try c.decodeIfPresent(String.self, forKey: DynamicKey(stringValue: "model")!)
      : nil
    modelId = keyNames.contains("modelId")
      ? try c.decodeIfPresent(String.self, forKey: DynamicKey(stringValue: "modelId")!)
      : nil
  }

  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: DynamicKey.self)
    if let provider { try c.encode(provider, forKey: DynamicKey(stringValue: "provider")!) }
    if let model { try c.encode(model, forKey: DynamicKey(stringValue: "model")!) }
    if let modelId { try c.encode(modelId, forKey: DynamicKey(stringValue: "modelId")!) }
  }

  private struct DynamicKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
  }
}

struct AgentActiveHoursConfig: Codable {
  var start: String
  var end: String
  var timezone: String
}

struct AgentHeartbeatConfig: Codable {
  var enabled: Bool
  var intervalSec: Int
  var wakeOnDemand: Bool
  var activeHours: AgentActiveHoursConfig?
}

struct AgentRuntimeConfigPatch: Codable {
  var heartbeat: AgentHeartbeatConfig?
  var maxConcurrentRuns: Int?
}

struct AgentLinearIdentityPatch: Codable {
  var userIds: [String]?
  var displayNames: [String]?
  var aliases: [String]?
}

struct AgentUpsertInput: Codable {
  var id: String?
  var name: String
  var role: String
  var title: String?
  var reportsTo: String?
  var capabilities: [String]?
  var status: String?
  var adapterType: String
  var adapterConfig: [String: RemoteJSONValue]?
  var runtimeConfig: AgentRuntimeConfigPatch?
  var linearIdentity: AgentLinearIdentityPatch?
  var budgetMonthlyCents: Int?
}

struct CtoSaveAgentPayload: Codable {
  var agent: AgentUpsertInput
  var actor: String?
}

/// Mirrors desktop `AgentIdentity`. `model` and `provider` are pulled from
/// `adapterConfig` by the computed properties below for display.
struct AgentIdentity: Codable, Hashable, Identifiable {
  var id: String
  var name: String
  var slug: String?
  var role: String
  var title: String?
  var reportsTo: String?
  var capabilities: [String]
  /// Raw status string from the server. Validate client-side against
  /// {"idle", "active", "paused", "running"} before acting on it.
  var status: String
  var adapterType: String
  var adapterConfig: AgentAdapterConfig?
  var personality: String?
  var systemPromptExtension: String?
  var budgetMonthlyCents: Int?
  var spentMonthlyCents: Int?
  var lastHeartbeatAt: String?
  var createdAt: String?
  var updatedAt: String?

  /// Flat accessors used by UI. Falls back through adapterConfig so the UI
  /// never has to know the nested shape.
  var model: String? { adapterConfig?.model ?? adapterConfig?.modelId }
  var provider: String? { adapterConfig?.provider }
}

struct AgentConfigRevision: Codable, Hashable, Identifiable {
  var id: String
  var agentId: String
  var createdAt: String
  var changedKeys: [String]
  var hadRedactions: Bool?
  var actor: String?
  var note: String?
}

/// Mirrors desktop `WorkerAgentRun`. Desktop uses `finishedAt`, not `endedAt`,
/// and `startedAt` is nullable.
struct WorkerAgentRun: Codable, Hashable, Identifiable {
  var id: String
  var agentId: String
  /// Raw status string from the server (e.g. "queued", "deferred", "running",
  /// "completed", "failed", "cancelled", "skipped"). Kept as `String` for
  /// forward compatibility.
  var status: String
  var wakeupReason: String?
  var taskKey: String?
  var issueKey: String?
  var executionRunId: String?
  var errorMessage: String?
  var startedAt: String?
  var finishedAt: String?
  var createdAt: String
  var updatedAt: String?

  /// Human-facing title. Desktop has no dedicated title field, so we derive
  /// one from the best available context.
  var displayTitle: String {
    if let issueKey, !issueKey.isEmpty { return issueKey }
    if let taskKey, !taskKey.isEmpty { return taskKey }
    return id
  }
}

struct AgentSessionLogEntry: Codable, Hashable, Identifiable {
  var id: String
  var sessionId: String?
  var summary: String?
  var startedAt: String?
  var endedAt: String?
  var provider: String?
  var modelId: String?
  var capabilityMode: String?
  var createdAt: String?
}

/// Mirrors desktop `AgentBudgetSummary` (the per-worker entry).
struct AgentBudgetSnapshotWorker: Codable, Hashable, Identifiable {
  var id: String { agentId }
  var agentId: String
  var name: String
  var budgetMonthlyCents: Int
  var spentMonthlyCents: Int
  var exactSpentCents: Int?
  var estimatedSpentCents: Int?
  var remainingCents: Int?
  var status: String?
}

/// Mirrors desktop `AgentBudgetSnapshot`. Field name is
/// `companyBudgetMonthlyCents`, not `companyCapMonthlyCents`.
struct AgentBudgetSnapshot: Codable, Hashable {
  var computedAt: String?
  var monthKey: String?
  var companyBudgetMonthlyCents: Int
  var companySpentMonthlyCents: Int
  var companyExactSpentCents: Int?
  var companyEstimatedSpentCents: Int?
  var companyRemainingCents: Int?
  var workers: [AgentBudgetSnapshotWorker]

  /// UI-friendly alias. Zero means "no cap tracked".
  var companyCapMonthlyCents: Int? {
    companyBudgetMonthlyCents > 0 ? companyBudgetMonthlyCents : nil
  }
}

// MARK: Linear sync

/// Mirrors desktop `LinearConnectionStatus` (as returned by
/// `cto.getLinearConnectionStatus`).
struct LinearConnectionStatus: Codable, Hashable {
  var tokenStored: Bool?
  var connected: Bool
  var viewerId: String?
  var viewerName: String?
  var organizationId: String?
  var organizationName: String?
  var organizationUrlKey: String?
  var organizationLogoUrl: String?
  var projectCount: Int?
  var projectPreview: [String]?
  var checkedAt: String?
  var message: String?
  var authMode: String?
  var oauthAvailable: Bool?
  var tokenExpiresAt: String?

  /// Convenience for the connection strip header.
  var lastSyncAt: String? { checkedAt }
}

struct LinearCatalogProject: Codable, Hashable, Identifiable {
  var id: String
  var name: String
  var slug: String?
  var key: String?
  var description: String?
  var url: String?
  var icon: String?
  var color: String?
}

struct LinearCatalogUser: Codable, Hashable, Identifiable {
  var id: String
  var name: String?
  var displayName: String?
  var email: String?
  var avatarUrl: String?
}

struct LinearCatalogState: Codable, Hashable, Identifiable {
  var id: String
  var name: String
  var type: String?
  var teamId: String?
  var teamKey: String?
}

struct LinearIssuePickerData: Codable, Hashable {
  var projects: [LinearCatalogProject]
  var users: [LinearCatalogUser]
  var states: [LinearCatalogState]
}

struct LinearQuickViewOrganization: Codable, Hashable {
  var id: String
  var name: String
  var urlKey: String?
  var logoUrl: String?
  var gitBranchFormat: String?
  var createdIssueCount: Int?
  var roadmapEnabled: Bool?
  var customersEnabled: Bool?
  var releasesEnabled: Bool?
}

struct LinearQuickViewViewer: Codable, Hashable {
  var id: String
  var name: String
  var displayName: String
  var email: String?
  var avatarUrl: String?
  var admin: Bool?
  var guest: Bool?
  var url: String?
}

struct LinearQuickViewProject: Codable, Hashable, Identifiable {
  var id: String
  var name: String
  var slug: String
  var teamName: String
  var teamKey: String?
  var url: String?
  var color: String?
  var icon: String?
  var description: String?
  var statusName: String?
  var statusType: String?
  var health: String?
  var progress: Double?
  var scope: Double?
  var priority: Int?
  var priorityLabel: String?
  var issueCount: Int?
  var completedIssueCount: Int?
  var startDate: String?
  var targetDate: String?
  var leadName: String?
  var teamKeys: [String]
}

struct LinearQuickViewTeam: Codable, Hashable, Identifiable {
  var id: String
  var key: String
  var name: String
  var displayName: String
  var color: String?
  var issueCount: Int?
  var cyclesEnabled: Bool?
  var `private`: Bool?
}

struct LinearQuickViewSdk: Codable, Hashable {
  var packageName: String
  var surfaces: [String]
}

struct LinearQuickView: Codable, Hashable {
  var connection: LinearConnectionStatus
  var organization: LinearQuickViewOrganization?
  var viewer: LinearQuickViewViewer?
  var projects: [LinearQuickViewProject]
  var teams: [LinearQuickViewTeam]
  var assignedIssues: [NormalizedLinearIssue]
  var recentIssues: [NormalizedLinearIssue]
  var fetchedAt: String
  var sdk: LinearQuickViewSdk?
}

struct NormalizedLinearIssueChild: Codable, Hashable, Identifiable {
  var id: String
  var identifier: String
  var title: String
  var stateId: String?
  var stateName: String?
  var stateType: String?
}

struct NormalizedLinearIssue: Codable, Hashable, Identifiable {
  var id: String
  var identifier: String
  var title: String
  var description: String?
  var url: String?
  var projectId: String?
  var projectSlug: String?
  var projectName: String?
  var teamId: String?
  var teamKey: String?
  var teamName: String?
  var stateId: String?
  var stateName: String?
  var stateType: String?
  var previousStateId: String?
  var previousStateName: String?
  var previousStateType: String?
  var priority: Int?
  var priorityLabel: String?
  var labels: [String]?
  var metadataTags: [String]?
  var assigneeId: String?
  var assigneeName: String?
  var ownerId: String?
  var creatorId: String?
  var creatorName: String?
  var blockerIssueIds: [String]?
  var hasOpenBlockers: Bool?
  var dueDate: String?
  var estimate: Double?
  var archivedAt: String?
  var completedAt: String?
  var canceledAt: String?
  var startedAt: String?
  var createdAt: String?
  var updatedAt: String?
  var childIssues: [NormalizedLinearIssueChild]?
}

struct LinearIssueSearchResultPageInfo: Codable, Hashable {
  var hasNextPage: Bool
  var endCursor: String?
}

struct LinearIssueSearchResult: Codable, Hashable {
  var issues: [NormalizedLinearIssue]
  var pageInfo: LinearIssueSearchResultPageInfo
}

struct LinearIssueSearchArgs: Codable, Hashable {
  var projectId: String? = nil
  var projectSlug: String? = nil
  var teamKey: String? = nil
  var stateTypes: [String]? = nil
  var assigneeId: String? = nil
  var priority: Int? = nil
  var query: String? = nil
  var first: Int? = nil
  var after: String? = nil
  var includeArchived: Bool? = nil
}

struct LinearIssueComment: Codable, Hashable, Identifiable {
  var id: String
  var body: String
  var createdAt: String
  var userName: String?
  var userDisplayName: String?
}

/// Flattens the desktop `LinearWorkflowTrigger` / `LinearWorkflowTarget`
/// objects into short display strings. Keeps the raw JSON around so a
/// re-encode doesn't destroy unknown fields.
struct LinearWorkflowDefinition: Codable, Hashable, Identifiable {
  var id: String
  var name: String
  var enabled: Bool
  var priority: Int?
  var description: String?

  /// Short display string derived from the server's nested `triggers` object.
  var triggerDisplay: String
  /// Short display string derived from the server's nested `target` object.
  var targetDisplay: String

  private enum CodingKeys: String, CodingKey {
    case id, name, enabled, priority, description, triggers, target
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    name = try c.decode(String.self, forKey: .name)
    enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
    priority = try c.decodeIfPresent(Int.self, forKey: .priority)
    description = try c.decodeIfPresent(String.self, forKey: .description)

    // Triggers is a structured object on desktop; flatten to a short label.
    let triggersValue = try? c.decode(AnyDecodable.self, forKey: .triggers)
    triggerDisplay = Self.describeTrigger(triggersValue?.value)

    let targetValue = try? c.decode(AnyDecodable.self, forKey: .target)
    targetDisplay = Self.describeTarget(targetValue?.value)
  }

  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(id, forKey: .id)
    try c.encode(name, forKey: .name)
    try c.encode(enabled, forKey: .enabled)
    try c.encodeIfPresent(priority, forKey: .priority)
    try c.encodeIfPresent(description, forKey: .description)
  }

  private static func describeTrigger(_ value: Any?) -> String {
    guard let dict = value as? [String: Any] else { return "—" }
    // LinearWorkflowTrigger typically has: { labels?: [], priorities?: [],
    // assignees?: [], states?: [], ... }. Pick the first present key and
    // summarize its values.
    let keys = ["labels", "priorities", "assignees", "states", "projects", "teams", "cycles"]
    for key in keys {
      if let arr = dict[key] as? [Any], !arr.isEmpty {
        let values = arr.compactMap { $0 as? String }
        if !values.isEmpty {
          return "\(key): \(values.prefix(3).joined(separator: ", "))"
        }
      }
    }
    if let any = dict["any"] as? Bool, any { return "any issue" }
    return "custom"
  }

  private static func describeTarget(_ value: Any?) -> String {
    guard let dict = value as? [String: Any] else { return "—" }
    let kind = (dict["type"] as? String) ?? (dict["kind"] as? String)
    if let kind {
      if kind == "worker_run" {
        if let workerId = dict["workerId"] as? String, !workerId.isEmpty {
          return "worker run · \(workerId)"
        }
        if let selector = dict["workerSelector"] as? [String: Any],
           let mode = selector["mode"] as? String,
           mode != "none",
           let value = selector["value"] as? String,
           !value.isEmpty {
          return "worker run · \(mode): \(value)"
        }
      }
      return kind.replacingOccurrences(of: "_", with: " ")
    }
    return "—"
  }
}

struct LinearWorkflowConfig: Codable, Hashable {
  var workflows: [LinearWorkflowDefinition]
}

/// Mirrors desktop `LinearSyncDashboard`. The UI summarizes `queue.*` into
/// flat counters via the computed properties below.
struct LinearSyncDashboardQueue: Codable, Hashable {
  var queued: Int
  var retryWaiting: Int
  var escalated: Int
  var dispatched: Int
  var failed: Int
}

struct LinearSyncDashboard: Codable, Hashable {
  var enabled: Bool?
  var running: Bool?
  var reconciliationIntervalSec: Int?
  var lastPollAt: String?
  var lastSuccessAt: String?
  var lastError: String?
  var queue: LinearSyncDashboardQueue?
  var claimsActive: Int?
  var watchOnlyHits: Int?

  var queuedCount: Int { queue?.queued ?? 0 }
  /// "Running" in mobile UI = dispatched (active) + escalated (needs attention).
  var runningCount: Int { (queue?.dispatched ?? 0) }
  /// "Completed" isn't tracked on the dashboard; show claims-active as a
  /// loose proxy for "work completed this cycle".
  var completedCount: Int { claimsActive ?? 0 }
  var failedCount: Int? { queue?.failed }
}

struct LinearSyncQueueItem: Codable, Hashable, Identifiable {
  var id: String
  var issueId: String
  var title: String?
  var status: String
  var dispatchedAt: String?
  var updatedAt: String?
}

struct LinearIngressEventRecord: Codable, Hashable, Identifiable {
  var id: String
  var issueId: String?
  var issueIdentifier: String?
  /// Raw ingress event kind (e.g. "issue.created", "issue.updated").
  var kind: String
  var summary: String?
  var timestamp: String?
  var receivedAt: String?
  var createdAt: String?

  /// UI-friendly timestamp preferring the most explicit field available.
  var displayTimestamp: String? { timestamp ?? receivedAt ?? createdAt }
  /// Issue ID is optional on desktop — fall back to "—" for display.
  var displayIssueId: String { issueIdentifier ?? issueId ?? "—" }

  private enum CodingKeys: String, CodingKey {
    case id, issueId, issueIdentifier, kind, entityType, action, summary, timestamp, receivedAt, createdAt
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    issueId = try c.decodeIfPresent(String.self, forKey: .issueId)
    issueIdentifier = try c.decodeIfPresent(String.self, forKey: .issueIdentifier)
    let explicitKind = try c.decodeIfPresent(String.self, forKey: .kind)
    let entityType = try c.decodeIfPresent(String.self, forKey: .entityType)
    let action = try c.decodeIfPresent(String.self, forKey: .action)
    if let explicitKind, !explicitKind.isEmpty {
      kind = explicitKind
    } else if let entityType, let action, !entityType.isEmpty, !action.isEmpty {
      kind = "\(entityType).\(action)"
    } else if let entityType, !entityType.isEmpty {
      kind = entityType
    } else if let action, !action.isEmpty {
      kind = action
    } else {
      kind = "event"
    }
    summary = try c.decodeIfPresent(String.self, forKey: .summary)
    timestamp = try c.decodeIfPresent(String.self, forKey: .timestamp)
    receivedAt = try c.decodeIfPresent(String.self, forKey: .receivedAt)
    createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
  }

  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(id, forKey: .id)
    try c.encodeIfPresent(issueId, forKey: .issueId)
    try c.encodeIfPresent(issueIdentifier, forKey: .issueIdentifier)
    try c.encode(kind, forKey: .kind)
    try c.encodeIfPresent(summary, forKey: .summary)
    try c.encodeIfPresent(timestamp, forKey: .timestamp)
    try c.encodeIfPresent(receivedAt, forKey: .receivedAt)
    try c.encodeIfPresent(createdAt, forKey: .createdAt)
  }
}

struct CtoTriggerAgentWakeupResult: Codable, Hashable {
  var ok: Bool?
  var runId: String?
  var message: String?
}

/// Small type-erased decoder used when we need to decode JSON values of
/// unknown shape (currently only for LinearWorkflowDefinition's nested
/// triggers/target trees).
private struct AnyDecodable: Decodable {
  let value: Any
  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if let bool = try? container.decode(Bool.self) { value = bool; return }
    if let int = try? container.decode(Int.self) { value = int; return }
    if let double = try? container.decode(Double.self) { value = double; return }
    if let string = try? container.decode(String.self) { value = string; return }
    if let array = try? container.decode([AnyDecodable].self) {
      value = array.map { $0.value }; return
    }
    if let dict = try? container.decode([String: AnyDecodable].self) {
      value = dict.mapValues { $0.value }; return
    }
    if container.decodeNil() { value = NSNull(); return }
    value = NSNull()
  }
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
  var codexFastMode: Bool?
  var executionMode: String?
  var permissionMode: String?
  var interactionMode: String?
  var claudePermissionMode: String?
  var codexApprovalPolicy: String?
  var codexSandbox: String?
  var codexConfigSource: String?
  var opencodePermissionMode: String?
  var droidPermissionMode: String?
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
  var archivedAt: String?
  var threadId: String?
  var requestedCwd: String?
  var createdAt: String
  var lastActivityAt: String
  // Orchestration-mode fields (populated when session is part of an orchestration run)
  var orchestrationRunId: String? = nil
  var orchestrationRole: String? = nil
  var orchestrationParentSessionId: String? = nil
  var orchestrationTag: String? = nil
  var orchestrationStepId: String? = nil
  var orchestrationBundlePath: String? = nil

  enum CodingKeys: String, CodingKey {
    case id
    case sessionId
    case laneId
    case provider
    case model
    case modelId
    case sessionProfile
    case reasoningEffort
    case codexFastMode
    case executionMode
    case permissionMode
    case interactionMode
    case claudePermissionMode
    case codexApprovalPolicy
    case codexSandbox
    case codexConfigSource
    case opencodePermissionMode
    case droidPermissionMode
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
    case archivedAt
    case threadId
    case requestedCwd
    case createdAt
    case lastActivityAt
    case orchestrationRunId
    case orchestrationRole
    case orchestrationParentSessionId
    case orchestrationTag
    case orchestrationStepId
    case orchestrationBundlePath
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
    codexFastMode = try container.decodeIfPresent(Bool.self, forKey: .codexFastMode)
    executionMode = try container.decodeIfPresent(String.self, forKey: .executionMode)
    permissionMode = try container.decodeIfPresent(String.self, forKey: .permissionMode)
    interactionMode = try container.decodeIfPresent(String.self, forKey: .interactionMode)
    claudePermissionMode = try container.decodeIfPresent(String.self, forKey: .claudePermissionMode)
    codexApprovalPolicy = try container.decodeIfPresent(String.self, forKey: .codexApprovalPolicy)
    codexSandbox = try container.decodeIfPresent(String.self, forKey: .codexSandbox)
    codexConfigSource = try container.decodeIfPresent(String.self, forKey: .codexConfigSource)
    opencodePermissionMode = try container.decodeIfPresent(String.self, forKey: .opencodePermissionMode)
    droidPermissionMode = try container.decodeIfPresent(String.self, forKey: .droidPermissionMode)
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
    archivedAt = try container.decodeIfPresent(String.self, forKey: .archivedAt)
    threadId = try container.decodeIfPresent(String.self, forKey: .threadId)
    requestedCwd = try container.decodeIfPresent(String.self, forKey: .requestedCwd)
    createdAt = try container.decode(String.self, forKey: .createdAt)
    lastActivityAt = try container.decodeIfPresent(String.self, forKey: .lastActivityAt) ?? createdAt
    orchestrationRunId = try container.decodeIfPresent(String.self, forKey: .orchestrationRunId)
    orchestrationRole = try container.decodeIfPresent(String.self, forKey: .orchestrationRole)
    orchestrationParentSessionId = try container.decodeIfPresent(String.self, forKey: .orchestrationParentSessionId)
    orchestrationTag = try container.decodeIfPresent(String.self, forKey: .orchestrationTag)
    orchestrationStepId = try container.decodeIfPresent(String.self, forKey: .orchestrationStepId)
    orchestrationBundlePath = try container.decodeIfPresent(String.self, forKey: .orchestrationBundlePath)
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
    try container.encodeIfPresent(codexFastMode, forKey: .codexFastMode)
    try container.encodeIfPresent(executionMode, forKey: .executionMode)
    try container.encodeIfPresent(permissionMode, forKey: .permissionMode)
    try container.encodeIfPresent(interactionMode, forKey: .interactionMode)
    try container.encodeIfPresent(claudePermissionMode, forKey: .claudePermissionMode)
    try container.encodeIfPresent(codexApprovalPolicy, forKey: .codexApprovalPolicy)
    try container.encodeIfPresent(codexSandbox, forKey: .codexSandbox)
    try container.encodeIfPresent(codexConfigSource, forKey: .codexConfigSource)
    try container.encodeIfPresent(opencodePermissionMode, forKey: .opencodePermissionMode)
    try container.encodeIfPresent(droidPermissionMode, forKey: .droidPermissionMode)
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
    try container.encodeIfPresent(orchestrationRunId, forKey: .orchestrationRunId)
    try container.encodeIfPresent(orchestrationRole, forKey: .orchestrationRole)
    try container.encodeIfPresent(orchestrationParentSessionId, forKey: .orchestrationParentSessionId)
    try container.encodeIfPresent(orchestrationTag, forKey: .orchestrationTag)
    try container.encodeIfPresent(orchestrationStepId, forKey: .orchestrationStepId)
    try container.encodeIfPresent(orchestrationBundlePath, forKey: .orchestrationBundlePath)
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
  var description: String?
  var recommended: Bool?
  var preview: String?
  var previewFormat: String?
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
    case displayText
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
      let text = try container.decode(String.self, forKey: .text)
      let displayText = try container.decodeIfPresent(String.self, forKey: .displayText)?
        .trimmingCharacters(in: .whitespacesAndNewlines)
      self = .userMessage(
        text: displayText.flatMap { $0.isEmpty ? nil : $0 } ?? text,
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

struct AgentChatDispatchSteerRequest: Codable, Equatable {
  var sessionId: String
  var steerId: String
  var mode: String
}

struct AgentChatCancelDispatchedSteerRequest: Codable, Equatable {
  var sessionId: String
  var steerId: String
}

struct AgentChatInterruptRequest: Codable, Equatable {
  var sessionId: String
}

struct AgentChatSessionIdRequest: Codable, Equatable {
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
  var codexFastMode: Bool?
  var permissionMode: String?
  var interactionMode: String?
  var claudePermissionMode: String?
  var codexApprovalPolicy: String?
  var codexSandbox: String?
  var codexConfigSource: String?
  var opencodePermissionMode: String?
  var droidPermissionMode: String?
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

struct AgentChatModelReasoningEffort: Codable, Equatable, Hashable, Identifiable {
  var id: String { effort }
  var effort: String
  var description: String
}

struct CursorModelAvailability: Codable, Equatable, Hashable {
  var cli: Bool
  var sdk: Bool
}

struct AgentChatModelInfo: Codable, Equatable, Identifiable {
  var id: String
  var displayName: String
  var description: String?
  var isDefault: Bool
  var reasoningEfforts: [AgentChatModelReasoningEffort]?
  var serviceTiers: [String]?
  var aliases: [String]? = nil
  var maxThinkingTokens: Int?
  var modelId: String?
  var family: String?
  var supportsReasoning: Bool?
  var supportsTools: Bool?
  var color: String?
  var cursorAvailability: CursorModelAvailability? = nil
}

extension AgentChatModelInfo {
  /// Mirrors desktop `modelSupportsServiceTier` — case-insensitive lookup so
  /// callers don't have to normalize before checking, e.g. "Fast" vs "fast".
  func supportsServiceTier(_ tier: String) -> Bool {
    let needle = tier.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !needle.isEmpty else { return false }
    return serviceTiers?.contains(where: { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == needle }) == true
  }

  var supportsCodexFastMode: Bool { supportsServiceTier("fast") }
}

struct AgentChatModelCatalogModel: Codable, Equatable, Identifiable {
  var id: String
  var runtimeModelId: String
  var provider: String
  var providerKey: String
  var groupKey: String
  var displayName: String
  var description: String?
  var isDefault: Bool
  var reasoningEfforts: [AgentChatModelReasoningEffort]?
  var serviceTiers: [String]?
  var aliases: [String]? = nil
  var maxThinkingTokens: Int?
  var modelId: String?
  var family: String?
  var supportsReasoning: Bool?
  var supportsTools: Bool?
  var cursorAvailability: CursorModelAvailability? = nil
  var color: String?
  var isAvailable: Bool
  var connected: Bool?
  var requiresConfiguration: Bool?
  var sourceRuntime: String?
  var providerId: String?
  var providerName: String?
  var stale: Bool?
}

struct AgentChatModelCatalogSubsection: Codable, Equatable, Identifiable {
  var id: String { key }
  var key: String
  var label: String
  var models: [AgentChatModelCatalogModel]
}

struct AgentChatModelCatalogProvider: Codable, Equatable, Identifiable {
  var id: String { key }
  var key: String
  var displayName: String
  var badgeColor: String
  var modelCount: Int
  var subsections: [AgentChatModelCatalogSubsection]
}

struct AgentChatModelCatalogGroup: Codable, Equatable, Identifiable {
  var id: String { key }
  var key: String
  var displayName: String
  var providers: [AgentChatModelCatalogProvider]
}

struct AgentChatModelCatalog: Codable, Equatable {
  var groups: [AgentChatModelCatalogGroup]
  var fetchedAt: String
  var stale: Bool?
}

/// Response envelopes for the cross-surface ModelPicker favorites/recents
/// RPC. Each method returns its own keyed wrapper (`{ favorites: [...] }` for
/// favorites methods, `{ recents: [...] }` for recents methods, plus
/// `toggleFavorite` adds an `isFavorite` boolean). Persistence lives in the
/// per-project cr-sqlite DB on the ade-cli host; `MAX_RECENTS = 10`.
struct ModelPickerFavorites: Codable, Equatable {
  var favorites: [String]

  init(favorites: [String] = []) {
    self.favorites = favorites
  }
}

struct ModelPickerToggleFavoriteResult: Codable, Equatable {
  var favorites: [String]
  var isFavorite: Bool

  init(favorites: [String] = [], isFavorite: Bool = false) {
    self.favorites = favorites
    self.isFavorite = isFavorite
  }
}

struct ModelPickerRecents: Codable, Equatable {
  var recents: [String]

  init(recents: [String] = []) {
    self.recents = recents
  }
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

struct UnregisteredLaneCandidate: Codable, Equatable, Identifiable {
  let path: String
  let branch: String
  var id: String { path }
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
  var previewKind: String? = nil
  var dataUrl: String? = nil
  var contentOmitted: Bool? = nil
  var omittedReason: String? = nil
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
  var archivedAt: String? = nil
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
  /// Parent chat session id when this terminal was launched from a chat (e.g. App Control,
  /// in-chat terminal drawer). Mirrors the desktop `TerminalSessionSummary.chatSessionId`.
  var chatSessionId: String? = nil
  /// Current pending approval/input item id when the backing chat is waiting on the user.
  var pendingInputItemId: String? = nil
  // Orchestration-mode fields (populated when the session is part of an orchestration run)
  var orchestrationRunId: String? = nil
  var orchestrationRole: String? = nil
  var orchestrationTag: String? = nil
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
  /// "pr_target" or "lane_base". Optional because legacy hosts / non-lane PRs omit it.
  var creationStrategy: String? = nil
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

public struct PrCommit: Codable, Equatable, Identifiable {
  public var id: String { sha }
  public var sha: String
  public var shortSha: String
  public var message: String
  public var authorLogin: String?
  public var authorName: String?
  public var authorEmail: String?
  public var committedDate: String
  /// "success" / "failure" / "pending" / "none". Optional for defensive decoding.
  public var checkStatus: String?

  private enum TopKeys: String, CodingKey {
    case sha, shortSha, message, author, committedDate, checkStatus
  }

  private enum AuthorKeys: String, CodingKey {
    case login, name, email
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: TopKeys.self)
    self.sha = try container.decode(String.self, forKey: .sha)
    self.shortSha = try container.decodeIfPresent(String.self, forKey: .shortSha) ?? String(sha.prefix(7))
    self.message = try container.decodeIfPresent(String.self, forKey: .message) ?? ""
    self.committedDate = try container.decodeIfPresent(String.self, forKey: .committedDate) ?? ""
    self.checkStatus = try container.decodeIfPresent(String.self, forKey: .checkStatus)

    if let authorContainer = try? container.nestedContainer(keyedBy: AuthorKeys.self, forKey: .author) {
      self.authorLogin = try authorContainer.decodeIfPresent(String.self, forKey: .login)
      self.authorName = try authorContainer.decodeIfPresent(String.self, forKey: .name)
      self.authorEmail = try authorContainer.decodeIfPresent(String.self, forKey: .email)
    } else {
      self.authorLogin = nil
      self.authorName = nil
      self.authorEmail = nil
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: TopKeys.self)
    try container.encode(sha, forKey: .sha)
    try container.encode(shortSha, forKey: .shortSha)
    try container.encode(message, forKey: .message)
    try container.encode(committedDate, forKey: .committedDate)
    try container.encodeIfPresent(checkStatus, forKey: .checkStatus)
    var authorContainer = container.nestedContainer(keyedBy: AuthorKeys.self, forKey: .author)
    try authorContainer.encodeIfPresent(authorLogin, forKey: .login)
    try authorContainer.encodeIfPresent(authorName, forKey: .name)
    try authorContainer.encodeIfPresent(authorEmail, forKey: .email)
  }

  public init(
    sha: String,
    shortSha: String,
    message: String,
    authorLogin: String?,
    authorName: String?,
    authorEmail: String?,
    committedDate: String,
    checkStatus: String?
  ) {
    self.sha = sha
    self.shortSha = shortSha
    self.message = message
    self.authorLogin = authorLogin
    self.authorName = authorName
    self.authorEmail = authorEmail
    self.committedDate = committedDate
    self.checkStatus = checkStatus
  }
}

struct PullRequestSnapshot: Codable, Equatable {
  var detail: PrDetail?
  var status: PrStatus?
  var checks: [PrCheck]
  var reviews: [PrReview]
  var comments: [PrComment]
  var files: [PrFile]
  /// Optional to remain defensive against older hosts that don't surface commits.
  var commits: [PrCommit]? = nil
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

public struct AiResolutionState: Codable, Equatable {
  public let prId: String?
  public let status: String?
  public let sessionId: String?
  public let model: String?
  public let reasoningEffort: String?
  public let startedAt: String?
  public let updatedAt: String?
  public let lastError: String?

  public init(
    prId: String? = nil,
    status: String? = nil,
    sessionId: String? = nil,
    model: String? = nil,
    reasoningEffort: String? = nil,
    startedAt: String? = nil,
    updatedAt: String? = nil,
    lastError: String? = nil
  ) {
    self.prId = prId
    self.status = status
    self.sessionId = sessionId
    self.model = model
    self.reasoningEffort = reasoningEffort
    self.startedAt = startedAt
    self.updatedAt = updatedAt
    self.lastError = lastError
  }
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
  /// Optional for defensive decoding against older hosts.
  var commits: [PrCommit]? = nil
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
  var integrationLaneOrigin: String?
  var linkedGroupId: String?
  var linkedPrId: String?
  var workflowDisplayState: String?
  var cleanupState: String?
  var closedAt: String?
  var mergedAt: String?
  var completedAt: String?
  var cleanupDeclinedAt: String?
  var cleanupCompletedAt: String?
  var preferredIntegrationLaneId: String?
  var mergeIntoHeadSha: String?
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
  /// Transcript byte offsets (UTF-8) covered by `transcript`. Absent on older
  /// hosts, which also never set `delta`.
  var startOffset: Int?
  var endOffset: Int?
  /// True when `transcript` only contains bytes from the requested
  /// `sinceOffset` to the end — append, don't replace.
  var delta: Bool?
  /// Whether a live PTY currently backs the session. False when a brain
  /// restart orphaned a "running" session — typing would go nowhere. Absent
  /// on older hosts.
  var live: Bool?
}

/// Response payload for `terminal_history`: transcript bytes
/// [startOffset, endOffset) ending at/before the requested `beforeOffset`.
struct TerminalHistorySlice: Codable, Equatable {
  var sessionId: String
  var data: String
  var startOffset: Int
  var endOffset: Int
  var atStart: Bool
}

struct StartCliSessionResult: Codable, Equatable {
  var sessionId: String
  var ptyId: String?
  var session: TerminalSessionSummary?
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
  var batchId: String
  var reason: String
  var fromDbVersion: Int
  var toDbVersion: Int
  var changes: [CrsqlChangeRow]

  init(batchId: String, reason: String, fromDbVersion: Int, toDbVersion: Int, changes: [CrsqlChangeRow]) {
    self.batchId = batchId
    self.reason = reason
    self.fromDbVersion = fromDbVersion
    self.toDbVersion = toDbVersion
    self.changes = changes
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    reason = try container.decode(String.self, forKey: .reason)
    fromDbVersion = try container.decode(Int.self, forKey: .fromDbVersion)
    toDbVersion = try container.decode(Int.self, forKey: .toDbVersion)
    changes = try container.decode([CrsqlChangeRow].self, forKey: .changes)
    let decodedBatchId = try container.decodeIfPresent(String.self, forKey: .batchId)?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let decodedBatchId, !decodedBatchId.isEmpty {
      batchId = decodedBatchId
    } else {
      batchId = Self.legacyBatchId(fromDbVersion: fromDbVersion, toDbVersion: toDbVersion, changes: changes)
    }
  }

  private static func legacyBatchId(fromDbVersion: Int, toDbVersion: Int, changes: [CrsqlChangeRow]) -> String {
    guard let last = changes.last else {
      return "legacy:\(fromDbVersion):\(toDbVersion):0:empty"
    }
    return "legacy:\(fromDbVersion):\(toDbVersion):\(changes.count):\(last.table):\(last.dbVersion):\(last.seq)"
  }

  private enum CodingKeys: String, CodingKey {
    case batchId
    case reason
    case fromDbVersion
    case toDbVersion
    case changes
  }
}

struct SyncChangesetAckPayload: Codable, Equatable {
  struct AckError: Codable, Equatable {
    var code: String
    var message: String
  }

  var batchId: String
  var fromDbVersion: Int
  var toDbVersion: Int
  var appliedDbVersion: Int
  var appliedCount: Int
  var ok: Bool
  var error: AckError?
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
  var preferredIntegrationLaneId: String?
  var mergeIntoHeadSha: String?
  var integrationLaneOrigin: String?
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
  var targetCommits: [RebaseTargetCommit]?
  /// Host-resolved rebase mode for the rebase card's lane: "auto" when the
  /// linked PR (or no PR) permits auto-rebase on base advance, "manual" when
  /// the PR carries an immutable base (lane_base strategy). Absent on older
  /// hosts — clients should default to "auto" when missing.
  var rebaseMode: String?
  /// Raw creation strategy of the lane's most-recent open/draft PR
  /// ("pr_target" | "lane_base"), or null when no PR is linked. Lets the
  /// client render strategy-specific copy without re-deriving the mode.
  var creationStrategy: String?

  private enum CodingKeys: String, CodingKey {
    case id
    case kind
    case queueId, groupId, groupName, targetBranch, state, activePrId, currentPosition, totalEntries, entries, waitReason, lastError, updatedAt
    case proposalId, title, baseBranch, overallOutcome
    case integrationStatus = "status"
    case laneCount, conflictLaneCount, lanes, workflowDisplayState, cleanupState, linkedPrId, integrationLaneId, preferredIntegrationLaneId, mergeIntoHeadSha, integrationLaneOrigin, createdAt
    case laneId, laneName, behindBy, conflictPredicted, prId, prNumber, dismissedAt, deferredUntil, targetCommits, rebaseMode, creationStrategy
  }
}

struct LaneWorktreeLockInfo: Codable, Equatable {
  var worktreeKey: String
  var worktreePath: String
  var laneId: String
  var ownerKind: String
  var ownerPrId: String?
  var ownerSessionId: String?
  var ownerProposalId: String?
  var ownerLabel: String
  var createdAt: String
  var heartbeatAt: String
  var expiresAt: String
}

struct LaneWorktreeLockBlocker: Codable, Equatable {
  var message: String
  var lock: LaneWorktreeLockInfo
}

/// Result envelope returned by `prs.pathToMerge.start`. `runtime` mirrors the
/// updated convergence runtime row that the host just wrote, so callers can
/// refresh local UI without an extra round-trip.
struct StartPathToMergeResult: Codable, Equatable {
  var prId: String
  var scheduled: Bool
  var runtime: ConvergenceRuntimeState
  var blockedBy: LaneWorktreeLockBlocker?
}

/// Result envelope returned by `prs.pathToMerge.stop`. `runtime` may be `nil`
/// when no runtime row existed for the PR (already-stopped no-op).
struct StopPathToMergeResult: Codable, Equatable {
  var prId: String
  var stopped: Bool
  var runtime: ConvergenceRuntimeState?
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
  var forceFinalizeUsed: Bool?
  var ciRetryAttemptsUsed: Int?
  var waitForCiStartedAt: String?
  var lastDispatchHeadSha: String?
  var pauseRepeatCount: Int?
  var lastPauseReasonHash: String?
  var lastStartedAt: String?
  var lastPolledAt: String?
  var lastPausedAt: String?
  var lastStoppedAt: String?
  var createdAt: String
  var updatedAt: String
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

struct CreateQueuePrError: Codable, Equatable {
  var laneId: String
  var error: String
}

struct CreateQueuePrsResult: Codable, Equatable {
  var groupId: String
  var prs: [PrSummary]
  var errors: [CreateQueuePrError]
}

struct IntegrationMergeResult: Codable, Equatable {
  var laneId: String
  var success: Bool
  var error: String?
}

struct CreateIntegrationPrResult: Codable, Equatable {
  var groupId: String
  var integrationLaneId: String
  var pr: PrSummary
  var mergeResults: [IntegrationMergeResult]
}

struct CleanupIntegrationWorkflowResult: Codable, Equatable {
  var proposalId: String
  var archivedLaneIds: [String]
  var skippedLaneIds: [String]
  var workflowDisplayState: String
  var cleanupState: String
}

struct LandResult: Codable, Equatable {
  var prId: String
  var prNumber: Int?
  var success: Bool
  var mergeCommitSha: String?
  var branchDeleted: Bool?
  var laneArchived: Bool?
  var error: String?
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
