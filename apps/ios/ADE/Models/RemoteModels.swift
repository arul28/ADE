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
  /// Full `wss://…/connect/<machineKey>` cloud-relay URLs learned from a pairing
  /// QR or advertised live by the host in `hello_ok`/`brain_status`. Optional so
  /// profiles persisted before the relay feature decode cleanly. Always raced
  /// LAST (after every LAN and Tailscale route) — unconditionally, no user
  /// toggle; the relay is a zero-config fallback.
  var savedRelayCandidates: [String]?
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
    savedRelayCandidates: [String]? = nil,
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
    self.savedRelayCandidates = savedRelayCandidates
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

/// A new-chat creation queued while offline. Persisted (App Group defaults) so
/// the Work list can render a "Pending sync" row that survives relaunch. `id`
/// is the stable command id of the queued `chat.create`; when that command
/// drains after reconnect the snapshot is removed and the real synced row
/// replaces it.
struct PendingChatCreation: Codable, Identifiable, Equatable {
  let id: String
  let projectId: String?
  let projectRootPath: String?
  let laneId: String
  let name: String
  let provider: String
  let model: String
  let queuedAt: String
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

struct MobileProjectForgetResultPayload: Codable, Equatable {
  var ok: Bool
  var message: String?
  var projectId: String?
  var rootPath: String?
}

struct MobileProjectBrowseEntry: Codable, Equatable, Identifiable {
  var id: String { fullPath }
  var name: String
  var fullPath: String
  var isGitRepo: Bool
}

struct MobileProjectBrowseResult: Codable, Equatable {
  var inputPath: String
  var resolvedPath: String
  var directoryPath: String
  var parentPath: String?
  var exactDirectoryPath: String?
  var openableProjectRoot: String?
  var entries: [MobileProjectBrowseEntry]
}

struct MobileProjectBrowseResultPayload: Codable, Equatable {
  var ok: Bool
  var message: String?
  var result: MobileProjectBrowseResult?
}

struct MobileProjectDefaultParentDirPayload: Codable, Equatable {
  var ok: Bool
  var message: String?
  var parentDir: String?
}

struct MobileProjectActionResultPayload: Codable, Equatable {
  var ok: Bool
  var message: String?
  var project: MobileProjectSummary?
}

struct MobileGitHubRepoSummary: Codable, Equatable, Identifiable {
  var id: String { fullName }
  var owner: String
  var name: String
  var fullName: String
  var isPrivate: Bool
  var pushedAt: String?
  var defaultBranch: String
  var htmlUrl: String
  var cloneUrl: String
  var sshUrl: String
}

struct MobileListMyGitHubReposResult: Codable, Equatable {
  var repos: [MobileGitHubRepoSummary]
}

struct MobileProjectListMyGitHubReposResultPayload: Codable, Equatable {
  var ok: Bool
  var message: String?
  var result: MobileListMyGitHubReposResult?
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
  var fastMode: Bool?
  var effectiveFastMode: Bool { fastMode ?? codexFastMode ?? false }
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

  static func == (lhs: AgentChatSessionSummary, rhs: AgentChatSessionSummary) -> Bool {
    lhs.sessionId == rhs.sessionId
      && lhs.laneId == rhs.laneId
      && lhs.provider == rhs.provider
      && lhs.model == rhs.model
      && lhs.modelId == rhs.modelId
      && lhs.sessionProfile == rhs.sessionProfile
      && lhs.title == rhs.title
      && lhs.goal == rhs.goal
      && lhs.reasoningEffort == rhs.reasoningEffort
      && lhs.codexFastMode == rhs.codexFastMode
      && lhs.fastMode == rhs.fastMode
      && lhs.executionMode == rhs.executionMode
      && lhs.permissionMode == rhs.permissionMode
      && lhs.interactionMode == rhs.interactionMode
      && lhs.claudePermissionMode == rhs.claudePermissionMode
      && lhs.codexApprovalPolicy == rhs.codexApprovalPolicy
      && lhs.codexSandbox == rhs.codexSandbox
      && lhs.codexConfigSource == rhs.codexConfigSource
      && lhs.opencodePermissionMode == rhs.opencodePermissionMode
      && lhs.droidPermissionMode == rhs.droidPermissionMode
      && lhs.cursorModeId == rhs.cursorModeId
      && lhs.cursorModeSnapshot == rhs.cursorModeSnapshot
      && lhs.cursorConfigValues == rhs.cursorConfigValues
      && lhs.computerUse == rhs.computerUse
      && lhs.completion == rhs.completion
      && lhs.identityKey == rhs.identityKey
      && lhs.surface == rhs.surface
      && lhs.automationId == rhs.automationId
      && lhs.automationRunId == rhs.automationRunId
      && lhs.capabilityMode == rhs.capabilityMode
      && lhs.status == rhs.status
      && lhs.idleSinceAt == rhs.idleSinceAt
      && lhs.startedAt == rhs.startedAt
      && lhs.endedAt == rhs.endedAt
      && lhs.archivedAt == rhs.archivedAt
      && lhs.lastActivityAt == rhs.lastActivityAt
      && lhs.lastOutputPreview == rhs.lastOutputPreview
      && lhs.summary == rhs.summary
      && lhs.awaitingInput == rhs.awaitingInput
      && lhs.pendingInputItemId == rhs.pendingInputItemId
      && lhs.threadId == rhs.threadId
      && lhs.requestedCwd == rhs.requestedCwd
      && lhs.orchestrationRunId == rhs.orchestrationRunId
      && lhs.orchestrationRole == rhs.orchestrationRole
      && lhs.orchestrationParentSessionId == rhs.orchestrationParentSessionId
      && lhs.orchestrationTag == rhs.orchestrationTag
      && lhs.orchestrationStepId == rhs.orchestrationStepId
      && lhs.orchestrationBundlePath == rhs.orchestrationBundlePath
  }
}

/// Composer mode fields carried by a `session_meta_updated` chat event when a
/// client (e.g. desktop) changes the session's permission / interaction mode.
/// Every field is optional so the decode never fails and older hosts — which
/// send only `title` / `manuallyNamed` — degrade to a no-op. Values are plain
/// strings (the summary stores these as `String?`, not failable enums), so an
/// unrecognized wire value patches through harmlessly instead of dropping the
/// whole event.
struct AgentChatSessionMetaModeUpdate: Decodable, Equatable {
  var permissionMode: String?
  var interactionMode: String?
  var claudePermissionMode: String?
  var codexApprovalPolicy: String?
  var codexSandbox: String?
  var codexConfigSource: String?
  var opencodePermissionMode: String?
  var droidPermissionMode: String?
  var cursorModeId: String?
  /// True when the event carried `cursorModeId: null` (an intentional clear the
  /// host emits to drop a cursor mode) rather than omitting the key. Absent-key
  /// still means "no change"; only an explicit null sets this so
  /// `applyModeUpdate` assigns nil instead of skipping.
  var cursorModeIdWasCleared: Bool = false
  var cursorModeSnapshot: RemoteJSONValue?
  var cursorConfigValues: [String: RemoteJSONValue]?
  /// True when the event carried `cursorConfigValues: null` (an intentional
  /// clear the host emits to drop the cursor config) rather than omitting the
  /// key. Symmetric with `cursorModeIdWasCleared`: absent-key still means "no
  /// change"; only an explicit null sets this so `applyModeUpdate` assigns nil.
  var cursorConfigValuesWasCleared: Bool = false

  private enum CodingKeys: String, CodingKey {
    case permissionMode
    case interactionMode
    case claudePermissionMode
    case codexApprovalPolicy
    case codexSandbox
    case codexSandboxMode
    case codexConfigSource
    case opencodePermissionMode
    case droidPermissionMode
    case cursorModeId
    case cursorModeSnapshot
    case cursorConfigValues
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    permissionMode = try c.decodeIfPresent(String.self, forKey: .permissionMode)
    interactionMode = try c.decodeIfPresent(String.self, forKey: .interactionMode)
    claudePermissionMode = try c.decodeIfPresent(String.self, forKey: .claudePermissionMode)
    codexApprovalPolicy = try c.decodeIfPresent(String.self, forKey: .codexApprovalPolicy)
    // Canonical key is `codexSandbox` (matches the summary + updateSession args).
    // Accept `codexSandboxMode` as a defensive fallback in case the host emits
    // that alternate spelling.
    if let sandbox = try c.decodeIfPresent(String.self, forKey: .codexSandbox) {
      codexSandbox = sandbox
    } else {
      codexSandbox = try c.decodeIfPresent(String.self, forKey: .codexSandboxMode)
    }
    codexConfigSource = try c.decodeIfPresent(String.self, forKey: .codexConfigSource)
    opencodePermissionMode = try c.decodeIfPresent(String.self, forKey: .opencodePermissionMode)
    droidPermissionMode = try c.decodeIfPresent(String.self, forKey: .droidPermissionMode)
    // Distinguish `cursorModeId: null` (an intentional clear) from an absent
    // key. decodeIfPresent collapses both to nil, so gate on `contains`: a
    // present-but-null key means the host cleared the cursor mode.
    if c.contains(.cursorModeId) {
      cursorModeId = try c.decodeIfPresent(String.self, forKey: .cursorModeId)
      cursorModeIdWasCleared = cursorModeId == nil
    } else {
      cursorModeId = nil
      cursorModeIdWasCleared = false
    }
    cursorModeSnapshot = try c.decodeIfPresent(RemoteJSONValue.self, forKey: .cursorModeSnapshot)
    // Same null-vs-absent distinction as cursorModeId: decodeIfPresent collapses
    // `cursorConfigValues: null` (an explicit clear) into absent, so gate on
    // `contains` to record the clear.
    if c.contains(.cursorConfigValues) {
      cursorConfigValues = try c.decodeIfPresent([String: RemoteJSONValue].self, forKey: .cursorConfigValues)
      cursorConfigValuesWasCleared = cursorConfigValues == nil
    } else {
      cursorConfigValues = nil
      cursorConfigValuesWasCleared = false
    }
  }

  /// True when the event carries at least one mode field. A bare
  /// title/manuallyNamed update decodes to all-nil here and is skipped.
  var hasAnyField: Bool {
    permissionMode != nil
      || interactionMode != nil
      || claudePermissionMode != nil
      || codexApprovalPolicy != nil
      || codexSandbox != nil
      || codexConfigSource != nil
      || opencodePermissionMode != nil
      || droidPermissionMode != nil
      || cursorModeId != nil
      || cursorModeIdWasCleared
      || cursorModeSnapshot != nil
      || cursorConfigValues != nil
      || cursorConfigValuesWasCleared
  }
}

extension AgentChatSessionSummary {
  /// Overlay the non-nil mode fields from an incoming `session_meta_updated`
  /// event. Absent fields leave the current value intact so a partial update
  /// (a change touched only one mode) never clears the others.
  mutating func applyModeUpdate(_ update: AgentChatSessionMetaModeUpdate) {
    if let v = update.permissionMode { permissionMode = v }
    if let v = update.interactionMode { interactionMode = v }
    if let v = update.claudePermissionMode { claudePermissionMode = v }
    if let v = update.codexApprovalPolicy { codexApprovalPolicy = v }
    if let v = update.codexSandbox { codexSandbox = v }
    if let v = update.codexConfigSource { codexConfigSource = v }
    if let v = update.opencodePermissionMode { opencodePermissionMode = v }
    if let v = update.droidPermissionMode { droidPermissionMode = v }
    if let v = update.cursorModeId {
      cursorModeId = v
    } else if update.cursorModeIdWasCleared {
      // Explicit `cursorModeId: null` from the host — drop the mode rather than
      // leaving the stale one in place.
      cursorModeId = nil
    }
    if let v = update.cursorModeSnapshot { cursorModeSnapshot = v }
    if let v = update.cursorConfigValues {
      cursorConfigValues = v
    } else if update.cursorConfigValuesWasCleared {
      // Explicit `cursorConfigValues: null` from the host — drop the config
      // rather than leaving the stale values in place.
      cursorConfigValues = nil
    }
  }

  /// Overlay the mode fields from another summary (used to fold a cache-side
  /// mode patch into an open view's live summary on a chat-event revision bump).
  ///
  /// The permission/interaction string fields copy only when non-nil: the host
  /// never null-clears them, and a partial refresh summary that omits one must
  /// not blank the live value.
  ///
  /// Cursor fields (`cursorModeId` / `cursorConfigValues`) copy WHOLESALE,
  /// including a nil. The cache is authoritative for cursor state — every writer
  /// (the `session_meta_updated` fold via `applyModeUpdate`, a full host summary
  /// via `cacheChatSummary`, or a lane-list refresh) stores the host's true
  /// value, and the host includes the field whenever a mode/config exists (a
  /// clear arrives as an explicit `null`, an unset session simply has no mode).
  /// So mirroring the cache's cursor fields — nil included — is exactly how an
  /// explicit clear reaches the live composer, with no separate clear flag or
  /// stateful marker to go stale.
  mutating func mergeModeFields(from other: AgentChatSessionSummary) {
    if let v = other.permissionMode { permissionMode = v }
    if let v = other.interactionMode { interactionMode = v }
    if let v = other.claudePermissionMode { claudePermissionMode = v }
    if let v = other.codexApprovalPolicy { codexApprovalPolicy = v }
    if let v = other.codexSandbox { codexSandbox = v }
    if let v = other.codexConfigSource { codexConfigSource = v }
    if let v = other.opencodePermissionMode { opencodePermissionMode = v }
    if let v = other.droidPermissionMode { droidPermissionMode = v }
    cursorModeId = other.cursorModeId
    if let v = other.cursorModeSnapshot { cursorModeSnapshot = v }
    cursorConfigValues = other.cursorConfigValues
  }
}

// MARK: - CTO Models (sync wire types)
//
// Field names mirror the desktop canonical types defined in
// apps/desktop/src/shared/types/{cto,linearSync}.ts. All status-ish fields come
// through as plain `String` so unknown server values don't break decoding.

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

/// Mirrors desktop `CtoOnboardingState`. Onboarding is complete once the
/// required `"identity"` step lands in `completedSteps` (the desktop also
/// stamps `completedAt` at that point).
struct CtoOnboardingState: Codable, Hashable {
  var completedSteps: [String]
  var dismissedAt: String?
  var completedAt: String?

  /// Mirror of desktop `hasCompletedRequiredOnboardingSteps`: the only
  /// required step is `"identity"`.
  var isComplete: Bool {
    completedAt != nil || completedSteps.contains("identity")
  }
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
  var onboardingState: CtoOnboardingState?
  var modelPreferences: CtoModelPreferences
  var updatedAt: String?

  /// Flat accessor used by UI code.
  var provider: String { modelPreferences.provider }
  /// Flat accessor used by UI code.
  var model: String { modelPreferences.model }
  /// Flat accessor used by UI code.
  var reasoningEffort: String? { modelPreferences.reasoningEffort }

  /// True once the CTO has been set up. Mirrors desktop: onboarding is complete
  /// when the required `"identity"` step has landed (or `completedAt` is set).
  var isOnboardingComplete: Bool {
    onboardingState?.isComplete ?? false
  }

  /// Mirrors the desktop gate (`needsOnboarding` in CtoPage): setup blocks the
  /// CTO surface only when it is neither complete nor dismissed. A user who
  /// tapped "Set up later" on any device must still reach the chat here.
  var isOnboardingBlocking: Bool {
    guard let state = onboardingState else { return true }
    return !state.isComplete && state.dismissedAt == nil
  }
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
  var onboardingState: CtoOnboardingState?
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

/// Returned by the `cto.getMemory` sync command: the durable facts the CTO
/// keeps (`MEMORY.md`), the rolling `thread-state.md`, and today's daily log.
/// Every field is tolerant of a missing/null value so a partial host response
/// still decodes — older hosts that don't implement the command surface as a
/// command error, not a decode failure.
struct CtoMemory: Codable, Hashable {
  var memory: String
  var threadState: String
  var dailyLog: String
  var dailyLogDate: String
  var updatedAt: String?

  init(
    memory: String = "",
    threadState: String = "",
    dailyLog: String = "",
    dailyLogDate: String = "",
    updatedAt: String? = nil
  ) {
    self.memory = memory
    self.threadState = threadState
    self.dailyLog = dailyLog
    self.dailyLogDate = dailyLogDate
    self.updatedAt = updatedAt
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    func str(_ key: CodingKeys) -> String? {
      (try? c.decodeIfPresent(String.self, forKey: key)).flatMap { $0 }
    }
    memory = str(.memory) ?? ""
    threadState = str(.threadState) ?? ""
    dailyLog = str(.dailyLog) ?? ""
    dailyLogDate = str(.dailyLogDate) ?? ""
    updatedAt = str(.updatedAt)
  }

  /// True when the host returned no substantive memory content yet.
  var isEmpty: Bool {
    memory.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && threadState.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && dailyLog.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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
  var fastMode: Bool?
  var effectiveFastMode: Bool { fastMode ?? codexFastMode ?? false }
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
    case fastMode
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
    fastMode = try container.decodeIfPresent(Bool.self, forKey: .fastMode)
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
    try container.encodeIfPresent(fastMode, forKey: .fastMode)
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
  case warning
  case error
  case config

  // The host's noticeKind union (see apps/desktop/src/shared/types/chat.ts) grows
  // over time. `system_notice.noticeKind` is a required, non-optional decode, so an
  // unrecognized value would throw — and because chat-event snapshots decode as a
  // single `[AgentChatEventEnvelope]` array, one bad notice discards the WHOLE
  // history, stranding pending-input cards (plan approvals, questions) behind the
  // plain-text fallback. Fall back to `.info` for unknown kinds so future additions
  // degrade to a generic notice instead of nuking the transcript.
  init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = AgentChatNoticeKind(rawValue: raw) ?? .info
  }
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

/// Lifecycle state for a context-compaction event. Hosts emit `started` when
/// compaction begins and `completed` when it finishes. Legacy `context_compact`
/// events omit the field entirely; callers treat a missing state as completed
/// so the end-only divider keeps rendering exactly as before.
enum AgentChatContextCompactState: String, Codable, Equatable {
  case started
  case completed
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
  var reasoningTokens: Int?
  var contextWindow: Int?
}

struct AgentChatCodexTokenUsageBreakdown: Codable, Equatable {
  var inputTokens: Int?
  var outputTokens: Int?
  var cacheReadTokens: Int?
  var cacheWriteTokens: Int?
  var reasoningTokens: Int?
  var totalTokens: Int?
}

struct AgentChatCodexThreadTokenUsage: Codable, Equatable {
  var threadId: String?
  var turnId: String?
  var total: AgentChatCodexTokenUsageBreakdown?
  var last: AgentChatCodexTokenUsageBreakdown?
  var modelContextWindow: Int?
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

/// Decodes an array element-by-element, dropping elements that fail to decode
/// instead of failing the whole array. Chat-event history arrives as one big
/// snapshot array; a single envelope the phone can't decode (e.g. a host that
/// has since grown a new enum value somewhere inside an event payload) must
/// degrade to "that one event is missing", never "the entire transcript is
/// gone" — the latter strands pending-input cards behind the plain-text
/// fallback and locks the composer.
@propertyWrapper
struct ADELossyArray<Element: Decodable & Equatable>: Decodable, Equatable {
  var wrappedValue: [Element]

  init(wrappedValue: [Element]) {
    self.wrappedValue = wrappedValue
  }

  init(from decoder: Decoder) throws {
    var container = try decoder.unkeyedContainer()
    var elements: [Element] = []
    while !container.isAtEnd {
      if let element = try? container.decode(Element.self) {
        elements.append(element)
      } else if (try? container.decode(RemoteJSONValue.self)) == nil {
        // A failed element decode does not advance the container; consume the
        // raw value to move past it. RemoteJSONValue accepts any JSON, so this
        // only fails on a corrupt stream — bail rather than loop forever.
        break
      }
    }
    wrappedValue = elements
  }
}

struct AgentChatEventHistorySnapshot: Decodable, Equatable {
  var sessionId: String
  @ADELossyArray var events: [AgentChatEventEnvelope]
  var truncated: Bool
  var transcriptTruncated: Bool?
  var windowTruncated: Bool?
  var sessionFound: Bool?
  var tailStartOffset: Int?
}

struct AgentChatEventHistoryPage: Decodable, Equatable {
  var sessionId: String
  @ADELossyArray var events: [AgentChatEventEnvelope]
  var startOffset: Int
  var hasMore: Bool
  var sessionFound: Bool
}

struct AgentChatFileRef: Codable, Equatable {
  var path: String
  var type: String
  var url: String? = nil
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
  case tokens(turnId: String, itemId: String?, inputTokens: Int?, outputTokens: Int?, cacheReadTokens: Int?, cacheWriteTokens: Int?, contextWindow: Int?)
  case codexTokenUsage(usage: AgentChatCodexThreadTokenUsage, turnId: String?)
  case activity(activity: AgentChatActivityKind, detail: String?, turnId: String?)
  case stepBoundary(stepNumber: Int, turnId: String?)
  case todoUpdate(items: [AgentChatTodoItem], turnId: String?)
  case subagentStarted(taskId: String, agentId: String?, agentType: String?, parentToolUseId: String?, description: String, background: Bool?, turnId: String?)
  case subagentProgress(taskId: String, agentId: String?, agentType: String?, parentToolUseId: String?, description: String?, summary: String, usage: AgentChatSubagentUsage?, lastToolName: String?, turnId: String?)
  case subagentResult(taskId: String, agentId: String?, agentType: String?, parentToolUseId: String?, status: AgentChatSubagentStatus, summary: String, usage: AgentChatSubagentUsage?, turnId: String?)
  case structuredQuestion(question: String, options: [AgentChatStructuredQuestionOption]?, itemId: String, turnId: String?)
  case toolUseSummary(summary: String, toolUseIds: [String], turnId: String?)
  case contextCompact(trigger: AgentChatContextCompactTrigger, preTokens: Int?, state: AgentChatContextCompactState?, turnId: String?)
  case codexContextCompaction(state: AgentChatContextCompactState, trigger: AgentChatContextCompactTrigger, turnId: String)
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
    case inputTokens
    case outputTokens
    case cacheReadTokens
    case cacheWriteTokens
    case contextWindow
    case activity
    case stepNumber
    case items
    case taskId
    case agentId
    case agentType
    case parentToolUseId
    case background
    case lastToolName
    case question
    case options
    case toolUseIds
    case trigger
    case preTokens
    case state
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
    case "tokens":
      self = .tokens(
        turnId: try container.decode(String.self, forKey: .turnId),
        itemId: try container.decodeIfPresent(String.self, forKey: .itemId),
        inputTokens: try container.decodeIfPresent(Int.self, forKey: .inputTokens),
        outputTokens: try container.decodeIfPresent(Int.self, forKey: .outputTokens),
        cacheReadTokens: try container.decodeIfPresent(Int.self, forKey: .cacheReadTokens),
        cacheWriteTokens: try container.decodeIfPresent(Int.self, forKey: .cacheWriteTokens),
        contextWindow: try container.decodeIfPresent(Int.self, forKey: .contextWindow)
      )
    case "codex_token_usage":
      self = .codexTokenUsage(
        usage: try container.decode(AgentChatCodexThreadTokenUsage.self, forKey: .usage),
        turnId: try container.decodeIfPresent(String.self, forKey: .turnId)
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
        agentId: try container.decodeIfPresent(String.self, forKey: .agentId),
        agentType: try container.decodeIfPresent(String.self, forKey: .agentType),
        parentToolUseId: try container.decodeIfPresent(String.self, forKey: .parentToolUseId),
        description: try container.decode(String.self, forKey: .description),
        background: try container.decodeIfPresent(Bool.self, forKey: .background),
        turnId: try container.decodeIfPresent(String.self, forKey: .turnId)
      )
    case "subagent_progress":
      self = .subagentProgress(
        taskId: try container.decode(String.self, forKey: .taskId),
        agentId: try container.decodeIfPresent(String.self, forKey: .agentId),
        agentType: try container.decodeIfPresent(String.self, forKey: .agentType),
        parentToolUseId: try container.decodeIfPresent(String.self, forKey: .parentToolUseId),
        description: try container.decodeIfPresent(String.self, forKey: .description),
        summary: try container.decode(String.self, forKey: .summary),
        usage: try container.decodeIfPresent(AgentChatSubagentUsage.self, forKey: .usage),
        lastToolName: try container.decodeIfPresent(String.self, forKey: .lastToolName),
        turnId: try container.decodeIfPresent(String.self, forKey: .turnId)
      )
    case "subagent_result":
      self = .subagentResult(
        taskId: try container.decode(String.self, forKey: .taskId),
        agentId: try container.decodeIfPresent(String.self, forKey: .agentId),
        agentType: try container.decodeIfPresent(String.self, forKey: .agentType),
        parentToolUseId: try container.decodeIfPresent(String.self, forKey: .parentToolUseId),
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
        state: try container.decodeIfPresent(AgentChatContextCompactState.self, forKey: .state),
        turnId: try container.decodeIfPresent(String.self, forKey: .turnId)
      )
    case "codex_context_compaction":
      self = .codexContextCompaction(
        state: try container.decode(AgentChatContextCompactState.self, forKey: .state),
        trigger: try container.decode(AgentChatContextCompactTrigger.self, forKey: .trigger),
        turnId: try container.decode(String.self, forKey: .turnId)
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
    case .tokens: return "tokens"
    case .codexTokenUsage: return "codex_token_usage"
    case .activity: return "activity"
    case .stepBoundary: return "step_boundary"
    case .todoUpdate: return "todo_update"
    case .subagentStarted: return "subagent_started"
    case .subagentProgress: return "subagent_progress"
    case .subagentResult: return "subagent_result"
    case .structuredQuestion: return "structured_question"
    case .toolUseSummary: return "tool_use_summary"
    case .contextCompact: return "context_compact"
    case .codexContextCompaction: return "codex_context_compaction"
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
  @ADELossyArray var events: [AgentChatEventEnvelope]
  /// Live turn state from the host's agent chat service at subscribe time.
  /// Snapshots are byte-capped transcript tails, so a long turn's
  /// `status: started` event can fall outside the tail; this flag is fresher
  /// than both the snapshot tail and the changeset-synced session row. Nil on
  /// older hosts and when the host has no live summary for the session.
  var turnActive: Bool?
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
  var messageId: String? = nil
  var itemId: String? = nil
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
  var signature: String? = nil
  var notModified: Bool? = nil
}

struct LaneRefreshPayload: Codable, Equatable {
  var refreshedCount: Int
  var lanes: [LaneSummary]
  var snapshots: [LaneListSnapshot]?
  var signature: String? = nil
  var notModified: Bool? = nil
}

/// The host's conditional-response shell for signature-checked lane commands.
/// A notModified response carries ONLY these fields (no payload body), so it
/// cannot decode as the full payload type — decode this first and fall through
/// to the full decode when `notModified` isn't true.
struct LaneNotModifiedEnvelope: Codable, Equatable {
  var signature: String? = nil
  var notModified: Bool? = nil
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
  var branchRef: String? = nil
  var rootPath: String
  var isReadOnlyByDefault: Bool

  init(
    id: String,
    kind: String,
    laneId: String?,
    name: String,
    branchRef: String? = nil,
    rootPath: String,
    isReadOnlyByDefault: Bool
  ) {
    self.id = id
    self.kind = kind
    self.laneId = laneId
    self.name = name
    self.branchRef = branchRef
    self.rootPath = rootPath
    self.isReadOnlyByDefault = isReadOnlyByDefault
  }

  private enum CodingKeys: String, CodingKey {
    case id
    case kind
    case laneId
    case name
    case branchRef
    case rootPath
    case isReadOnlyByDefault
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decode(String.self, forKey: .id)
    kind = try container.decode(String.self, forKey: .kind)
    laneId = try container.decodeIfPresent(String.self, forKey: .laneId)
    name = try container.decode(String.self, forKey: .name)
    branchRef = try container.decodeIfPresent(String.self, forKey: .branchRef)
    rootPath = try container.decode(String.self, forKey: .rootPath)
    isReadOnlyByDefault = try container.decode(Bool.self, forKey: .isReadOnlyByDefault)
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

  static func == (lhs: TerminalSessionSummary, rhs: TerminalSessionSummary) -> Bool {
    lhs.id == rhs.id
      && lhs.laneId == rhs.laneId
      && lhs.laneName == rhs.laneName
      && lhs.ptyId == rhs.ptyId
      && lhs.tracked == rhs.tracked
      && lhs.pinned == rhs.pinned
      && lhs.manuallyNamed == rhs.manuallyNamed
      && lhs.goal == rhs.goal
      && lhs.toolType == rhs.toolType
      && lhs.title == rhs.title
      && lhs.status == rhs.status
      && lhs.startedAt == rhs.startedAt
      && lhs.endedAt == rhs.endedAt
      && lhs.archivedAt == rhs.archivedAt
      && lhs.exitCode == rhs.exitCode
      && lhs.transcriptPath == rhs.transcriptPath
      && lhs.headShaStart == rhs.headShaStart
      && lhs.headShaEnd == rhs.headShaEnd
      && lhs.lastOutputPreview == rhs.lastOutputPreview
      && lhs.summary == rhs.summary
      && lhs.runtimeState == rhs.runtimeState
      && lhs.resumeCommand == rhs.resumeCommand
      && lhs.resumeMetadata?.provider == rhs.resumeMetadata?.provider
      && lhs.resumeMetadata?.targetKind == rhs.resumeMetadata?.targetKind
      && lhs.resumeMetadata?.targetId == rhs.resumeMetadata?.targetId
      && lhs.resumeMetadata?.target == rhs.resumeMetadata?.target
      && lhs.resumeMetadata?.launch == rhs.resumeMetadata?.launch
      && lhs.resumeMetadata?.permissionMode == rhs.resumeMetadata?.permissionMode
      && lhs.chatIdleSinceAt == rhs.chatIdleSinceAt
      && lhs.chatSessionId == rhs.chatSessionId
      && lhs.pendingInputItemId == rhs.pendingInputItemId
      && lhs.orchestrationRunId == rhs.orchestrationRunId
      && lhs.orchestrationRole == rhs.orchestrationRole
      && lhs.orchestrationTag == rhs.orchestrationTag
  }
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

/// GitHub merge-box state, mirrored from the desktop `MergeStateStatus` union
/// (GraphQL `mergeStateStatus`, normalized lowercase). Decoded safely: an
/// unrecognized wire value falls back to `.unknown` rather than failing the
/// whole snapshot decode.
enum PrMergeStateStatus: String, Codable, Equatable {
  case behind
  case blocked
  case clean
  case dirty
  case draft
  case hasHooks = "has_hooks"
  case unknown
  case unstable

  init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = PrMergeStateStatus(rawValue: raw.lowercased()) ?? .unknown
  }
}

/// GitHub GraphQL `reviewDecision`. Null on the wire when no reviews are
/// required; an unrecognized value decodes to nil so older/newer hosts don't
/// break the snapshot decode.
enum PrReviewDecisionValue: String, Codable, Equatable {
  case approved
  case changesRequested = "changes_requested"
  case reviewRequired = "review_required"
}

struct PrStatus: Codable, Equatable {
  var prId: String
  var state: String
  var checksStatus: String
  var reviewStatus: String
  var isMergeable: Bool
  var mergeConflicts: Bool
  var behindBaseBy: Int
  /// GitHub merge-box state. Optional/nil for older runtimes or while computing.
  var mergeStateStatus: PrMergeStateStatus?
  /// GitHub GraphQL `reviewDecision`. Nil when no reviews are required.
  var reviewDecision: PrReviewDecisionValue?
  /// Approving reviews counted, when GitHub exposes it (for "0 of 1").
  var approvalsCount: Int?
  /// Required approving reviews, when GitHub exposes it.
  var requiredApprovals: Int?
  /// True while GitHub is still computing mergeability — the merge UI keeps polling.
  var mergeabilityComputing: Bool?
  /// Viewer can bypass branch protection (admin / bypass permission).
  var canBypass: Bool?
  /// Head SHA at the time status was computed; used for the stale-head guard.
  var headSha: String?

  /// Decodes an unknown `reviewDecision` string to nil instead of throwing, so a
  /// new GitHub enum value never fails the whole snapshot decode. All other
  /// fields use synthesized decoding via `decodeIfPresent` semantics.
  private enum CodingKeys: String, CodingKey {
    case prId, state, checksStatus, reviewStatus, isMergeable, mergeConflicts, behindBaseBy
    case mergeStateStatus, reviewDecision, approvalsCount, requiredApprovals
    case mergeabilityComputing, canBypass, headSha
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    prId = try c.decode(String.self, forKey: .prId)
    state = try c.decode(String.self, forKey: .state)
    checksStatus = try c.decode(String.self, forKey: .checksStatus)
    reviewStatus = try c.decode(String.self, forKey: .reviewStatus)
    isMergeable = try c.decode(Bool.self, forKey: .isMergeable)
    mergeConflicts = try c.decode(Bool.self, forKey: .mergeConflicts)
    behindBaseBy = try c.decode(Int.self, forKey: .behindBaseBy)
    mergeStateStatus = try c.decodeIfPresent(PrMergeStateStatus.self, forKey: .mergeStateStatus)
    // Unknown reviewDecision → nil rather than a decode failure.
    if let raw = try c.decodeIfPresent(String.self, forKey: .reviewDecision) {
      reviewDecision = PrReviewDecisionValue(rawValue: raw)
    } else {
      reviewDecision = nil
    }
    approvalsCount = try c.decodeIfPresent(Int.self, forKey: .approvalsCount)
    requiredApprovals = try c.decodeIfPresent(Int.self, forKey: .requiredApprovals)
    mergeabilityComputing = try c.decodeIfPresent(Bool.self, forKey: .mergeabilityComputing)
    canBypass = try c.decodeIfPresent(Bool.self, forKey: .canBypass)
    headSha = try c.decodeIfPresent(String.self, forKey: .headSha)
  }

  /// Memberwise init retained for previews / tests now that a custom decoder
  /// suppresses Swift's synthesized one.
  init(
    prId: String,
    state: String,
    checksStatus: String,
    reviewStatus: String,
    isMergeable: Bool,
    mergeConflicts: Bool,
    behindBaseBy: Int,
    mergeStateStatus: PrMergeStateStatus? = nil,
    reviewDecision: PrReviewDecisionValue? = nil,
    approvalsCount: Int? = nil,
    requiredApprovals: Int? = nil,
    mergeabilityComputing: Bool? = nil,
    canBypass: Bool? = nil,
    headSha: String? = nil
  ) {
    self.prId = prId
    self.state = state
    self.checksStatus = checksStatus
    self.reviewStatus = reviewStatus
    self.isMergeable = isMergeable
    self.mergeConflicts = mergeConflicts
    self.behindBaseBy = behindBaseBy
    self.mergeStateStatus = mergeStateStatus
    self.reviewDecision = reviewDecision
    self.approvalsCount = approvalsCount
    self.requiredApprovals = requiredApprovals
    self.mergeabilityComputing = mergeabilityComputing
    self.canBypass = canBypass
    self.headSha = headSha
  }
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
  /// Owner/name of the PR's head repository. Differs from `repoOwner`/`repoName`
  /// for fork PRs; used to reject a fork PR whose head branch name coincides with
  /// a local lane branch. Nil against older hosts that don't send these fields.
  var headRepoOwner: String? = nil
  var headRepoName: String? = nil
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

struct ExternalSessionCapabilities: Codable, Equatable {
  var resumeInPlace: Bool
  var resumeInDifferentCwd: Bool
  var fork: Bool
  var forkIntoDifferentCwd: Bool
  var importToChat: Bool

  init(
    resumeInPlace: Bool = false,
    resumeInDifferentCwd: Bool = false,
    fork: Bool = false,
    forkIntoDifferentCwd: Bool = false,
    importToChat: Bool = false
  ) {
    self.resumeInPlace = resumeInPlace
    self.resumeInDifferentCwd = resumeInDifferentCwd
    self.fork = fork
    self.forkIntoDifferentCwd = forkIntoDifferentCwd
    self.importToChat = importToChat
  }

  private enum CodingKeys: String, CodingKey {
    case resumeInPlace
    case resumeInDifferentCwd
    case fork
    case forkIntoDifferentCwd
    case importToChat
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    resumeInPlace = try container.decodeIfPresent(Bool.self, forKey: .resumeInPlace) ?? false
    resumeInDifferentCwd = try container.decodeIfPresent(Bool.self, forKey: .resumeInDifferentCwd) ?? false
    fork = try container.decodeIfPresent(Bool.self, forKey: .fork) ?? false
    forkIntoDifferentCwd = try container.decodeIfPresent(Bool.self, forKey: .forkIntoDifferentCwd) ?? false
    importToChat = try container.decodeIfPresent(Bool.self, forKey: .importToChat) ?? false
  }
}

struct ExternalSessionSummary: Codable, Identifiable, Equatable {
  var provider: String
  var id: String
  var cwd: String?
  var title: String?
  var preview: String?
  var createdAt: Double?
  var updatedAt: Double?
  var messageCount: Int?
  var alreadyImported: Bool
  var possiblyActive: Bool
  var cwdMatchesRequestedLane: Bool?
  var capabilities: ExternalSessionCapabilities

  private enum CodingKeys: String, CodingKey {
    case provider
    case id
    case cwd
    case title
    case preview
    case createdAt
    case updatedAt
    case messageCount
    case alreadyImported
    case possiblyActive
    case cwdMatchesRequestedLane
    case capabilities
  }

  init(
    provider: String,
    id: String,
    cwd: String? = nil,
    title: String? = nil,
    preview: String? = nil,
    createdAt: Double? = nil,
    updatedAt: Double? = nil,
    messageCount: Int? = nil,
    alreadyImported: Bool = false,
    possiblyActive: Bool = false,
    cwdMatchesRequestedLane: Bool? = nil,
    capabilities: ExternalSessionCapabilities = ExternalSessionCapabilities()
  ) {
    self.provider = provider
    self.id = id
    self.cwd = cwd
    self.title = title
    self.preview = preview
    self.createdAt = createdAt
    self.updatedAt = updatedAt
    self.messageCount = messageCount
    self.alreadyImported = alreadyImported
    self.possiblyActive = possiblyActive
    self.cwdMatchesRequestedLane = cwdMatchesRequestedLane
    self.capabilities = capabilities
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    provider = try container.decodeIfPresent(String.self, forKey: .provider) ?? "unknown"
    id = try container.decode(String.self, forKey: .id)
    cwd = try container.decodeIfPresent(String.self, forKey: .cwd)
    title = try container.decodeIfPresent(String.self, forKey: .title)
    preview = try container.decodeIfPresent(String.self, forKey: .preview)
    createdAt = try container.decodeIfPresent(Double.self, forKey: .createdAt)
    updatedAt = try container.decodeIfPresent(Double.self, forKey: .updatedAt)
    messageCount = try container.decodeIfPresent(Int.self, forKey: .messageCount)
    alreadyImported = try container.decodeIfPresent(Bool.self, forKey: .alreadyImported) ?? false
    possiblyActive = try container.decodeIfPresent(Bool.self, forKey: .possiblyActive) ?? false
    cwdMatchesRequestedLane = try container.decodeIfPresent(Bool.self, forKey: .cwdMatchesRequestedLane)
    capabilities = try container.decodeIfPresent(ExternalSessionCapabilities.self, forKey: .capabilities)
      ?? ExternalSessionCapabilities()
  }
}

struct ExternalSessionListResult: Decodable, Equatable {
  var sessions: [ExternalSessionSummary]

  private enum CodingKeys: String, CodingKey {
    case sessions
  }

  init(sessions: [ExternalSessionSummary]) {
    self.sessions = sessions
  }

  init(from decoder: Decoder) throws {
    if var array = try? decoder.unkeyedContainer() {
      var decoded: [ExternalSessionSummary] = []
      while !array.isAtEnd {
        if let session = try? array.decode(ExternalSessionSummary.self) {
          decoded.append(session)
        } else if (try? array.decode(RemoteJSONValue.self)) == nil {
          break
        }
      }
      sessions = decoded
      return
    }

    let container = try decoder.container(keyedBy: CodingKeys.self)
    if let lossy = try? container.decode(ADELossyArray<ExternalSessionSummary>.self, forKey: .sessions) {
      sessions = lossy.wrappedValue
    } else {
      sessions = []
    }
  }
}

struct ExternalSessionImportResult: Codable, Equatable {
  var kind: String
  var sessionId: String?
  var ptyId: String?
  var laneId: String?
  var chatSessionId: String?
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
  /// GitHub merge-box state, so mobile renders the same blocker detail as desktop.
  var mergeStateStatus: PrMergeStateStatus?
  /// Viewer can bypass branch protection (admin / bypass permission).
  var canBypass: Bool?
  /// Branch is behind base and can be updated from the merge surface.
  var canUpdateBranch: Bool?
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
