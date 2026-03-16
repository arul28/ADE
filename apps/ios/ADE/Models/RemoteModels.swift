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

struct SyncPairingSession: Codable, Equatable {
  var code: String
  var issuedAt: String
  var expiresAt: String
}

struct LaneStatus: Codable, Equatable {
  var dirty: Bool
  var ahead: Int
  var behind: Int
  var remoteBehind: Int
  var rebaseInProgress: Bool
}

struct LaneSummary: Codable, Identifiable, Equatable {
  var id: String
  var name: String
  var description: String?
  var laneType: String
  var baseRef: String
  var branchRef: String
  var worktreePath: String
  var parentLaneId: String?
  var childCount: Int
  var stackDepth: Int
  var status: LaneStatus
  var createdAt: String
  var archivedAt: String?
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

  private enum CodingKeys: String, CodingKey {
    case reason
    case fromDbVersion = "fromDbVersion"
    case toDbVersion = "toDbVersion"
    case changes
  }
}

struct ApplyRemoteChangesResult: Equatable {
  var appliedCount: Int
  var dbVersion: Int
  var touchedTables: [String]
  var rebuiltFts: Bool
}
