import Foundation

/// Cursor owns the name of a cloud agent. ADE mirrors that name and must not
/// offer a local rename. Same sentence as `CURSOR_CLOUD_RENAME_BLOCKED_MESSAGE`.
enum CursorCloudNaming {
  static let renameBlockedMessage =
    "Cursor Cloud agent names are managed by Cursor. Rename this agent on cursor.com."

  static func ownsName(_ agentId: String?) -> Bool {
    !(agentId?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
  }
}

/// Decoded payloads for the global Cursor Cloud pane. Mirrors
/// `CursorCloudFleetResult` in desktop shared/types/config.ts; every field is
/// optional-tolerant so an older host cannot crash the pane.

struct CursorCloudFleetOwnership: Codable, Equatable, Hashable {
  var sessionId: String?
  var sessionTitle: String?
  var laneId: String?
  var laneName: String?
  /// Linear identifier such as ADE-12.
  var linearIssueId: String?
}

/// Epoch-ms numbers arrive as JSON numbers, ISO strings as strings; accept both.
enum CursorCloudTimestamp: Codable, Equatable, Hashable {
  case epochMs(Double)
  case iso(String)

  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if let value = try? container.decode(Double.self) {
      self = .epochMs(value)
      return
    }
    if let value = try? container.decode(String.self) {
      self = .iso(value)
      return
    }
    throw DecodingError.typeMismatch(
      CursorCloudTimestamp.self,
      DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Expected number or string timestamp")
    )
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .epochMs(let value): try container.encode(value)
    case .iso(let value): try container.encode(value)
    }
  }

  var date: Date? {
    switch self {
    case .epochMs(let ms):
      return Date(timeIntervalSince1970: ms > 1_000_000_000_000 ? ms / 1000 : ms)
    case .iso(let text):
      return ISO8601DateFormatter.flexible.date(from: text)
        ?? ISO8601DateFormatter.plain.date(from: text)
    }
  }
}

extension ISO8601DateFormatter {
  static let flexible: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()

  static let plain: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter
  }()
}

struct CursorCloudAgentSummary: Codable, Equatable, Hashable, Identifiable {
  var agentId: String
  var name: String
  var summary: String
  var status: String?
  var archived: Bool?
  var lastModified: CursorCloudTimestamp?
  var createdAt: CursorCloudTimestamp?
  var repos: [String]?
  var webUrl: String?

  var id: String { agentId }

  var isArchived: Bool { archived == true }

  /// Desktop lowercases statuses before they cross the wire; normalize
  /// defensively so a raw `RUNNING` from an older producer cannot drift.
  var normalizedStatus: String? {
    status?.lowercased()
  }

  var effectiveStatus: String {
    if isArchived { return "archived" }
    // Desktop's shared status helper maps a live agent with no known run
    // state to "creating"; mirror that so Active filters and Stop agree.
    switch normalizedStatus {
    case "running", "finished", "error": return normalizedStatus!
    case nil: return "creating"
    default: return "creating"
    }
  }

  var isActiveRun: Bool {
    !isArchived && (effectiveStatus == "running" || effectiveStatus == "creating")
  }

  var lastActivityDate: Date? {
    lastModified?.date ?? createdAt?.date
  }
}

struct CursorCloudFleetEntry: Codable, Equatable, Hashable, Identifiable {
  var agent: CursorCloudAgentSummary
  var runStatus: String?
  var latestRunId: String?
  var branch: String?
  var prUrl: String?
  var modelId: String?
  var ownership: CursorCloudFleetOwnership
  /// "session", "repo", "both", or "account".
  var matchedBy: String?

  var id: String { agent.agentId }

  var displayStatus: String {
    if agent.isArchived { return "archived" }
    if let runStatus { return runStatus.lowercased() }
    return agent.effectiveStatus
  }

  var isActiveRun: Bool {
    !agent.isArchived && (displayStatus == "running" || displayStatus == "creating")
  }
}

struct CursorCloudFleetResult: Codable, Equatable {
  var items: [CursorCloudFleetEntry]
  /// "unconfigured", "ready", or "error".
  var relayState: String?
  var lastEventAt: String?
  var fetchedAt: String?

  var relayLive: Bool { relayState == "ready" }
}

/// Minimal projection of `ai.getStatus` used for the same connection gate as
/// the desktop Cursor Cloud surfaces. Keeping this payload narrow lets iOS
/// talk to newer hosts without coupling the view to the full AI settings
/// schema.
struct CursorCloudConnectionStatus: Codable, Equatable {
  struct ProviderConnection: Codable, Equatable {
    var authAvailable: Bool?
  }

  var providerConnections: [String: ProviderConnection]?

  var connected: Bool {
    providerConnections?["cursor"]?.authAvailable == true
  }
}

struct CursorCloudArtifactSummary: Codable, Equatable, Hashable, Identifiable {
  var path: String
  var sizeBytes: Int?
  var updatedAt: String?
  var mimeType: String?

  var id: String { path }
}

struct CursorCloudRepository: Codable, Equatable, Hashable, Identifiable {
  var url: String

  var id: String { url }
}

struct CursorCloudRunSummary: Codable, Equatable, Hashable, Identifiable {
  var runId: String
  var agentId: String
  var status: String
  var modelId: String?
  var git: CursorCloudRunGit?

  var id: String { runId }

  var primaryBranch: String? {
    git?.branches?.first(where: { !($0.branch?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true) })?.branch
  }

  var primaryPrUrl: String? {
    git?.branches?.first(where: { !($0.prUrl?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true) })?.prUrl
  }
}

struct CursorCloudRunGit: Codable, Equatable, Hashable {
  var branches: [CursorCloudRunBranch]?
}

struct CursorCloudRunBranch: Codable, Equatable, Hashable {
  var repoUrl: String?
  var branch: String?
  var prUrl: String?
}

struct CursorCloudRunListResult: Codable, Equatable {
  var items: [CursorCloudRunSummary]
  var nextCursor: String?
}

struct CursorCloudCreateRunResult: Codable, Equatable {
  var agent: CursorCloudAgentSummary
  var run: CursorCloudRunSummary
}

struct CursorCloudResolvedLane: Codable, Equatable {
  var laneId: String
  var laneName: String
  var created: Bool?
}

struct CursorCloudPullResult: Codable, Equatable {
  /// "pulled" or "created_lane".
  var status: String
  var laneId: String
  var laneName: String
  var sessionId: String?
  var mergedBranch: String
}

struct CursorCloudOpenChatResult: Codable, Equatable {
  var sessionId: String
}
