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
  var pairingCode: String
  var expiresAt: String
  var addressCandidates: [SyncAddressCandidate]
}

struct SyncPairingSession: Codable, Equatable {
  var code: String
  var issuedAt: String
  var expiresAt: String
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
  var identityKey: String?
  var surface: String?
  var automationId: String?
  var automationRunId: String?
  var capabilityMode: String?
  var completion: ChatCompletionReport?
  var status: String
  var startedAt: String
  var endedAt: String?
  var lastActivityAt: String
  var lastOutputPreview: String?
  var summary: String?
  var threadId: String?
}

struct ChatCompletionReport: Codable, Equatable {
  var timestamp: String
  var summary: String
  var status: String
  var blockerDescription: String?
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
