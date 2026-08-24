import Foundation

/// Decoded payloads for the global Cursor Cloud pane. Mirrors
/// `CursorCloudFleetResult` in desktop shared/types/config.ts; every field is
/// optional-tolerant so an older host cannot crash the pane.

struct CursorCloudFleetOwnership: Codable, Equatable {
  var sessionId: String?
  var sessionTitle: String?
  var laneId: String?
  var laneName: String?
  /// Linear identifier such as ADE-12.
  var linearIssueId: String?
}

/// Epoch-ms numbers arrive as JSON numbers, ISO strings as strings; accept both.
enum CursorCloudTimestamp: Codable, Equatable {
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

struct CursorCloudAgentSummary: Codable, Equatable, Identifiable {
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

  var effectiveStatus: String {
    if isArchived { return "archived" }
    return status ?? "unknown"
  }

  var isActiveRun: Bool {
    !isArchived && (status == "running" || status == "creating")
  }

  var lastActivityDate: Date? {
    lastModified?.date ?? createdAt?.date
  }
}

struct CursorCloudFleetEntry: Codable, Equatable, Identifiable {
  var agent: CursorCloudAgentSummary
  var runStatus: String?
  var latestRunId: String?
  var branch: String?
  var prUrl: String?
  var modelId: String?
  var ownership: CursorCloudFleetOwnership
  /// "session", "repo", or "both".
  var matchedBy: String?

  var id: String { agent.agentId }

  var displayStatus: String {
    if agent.isArchived { return "archived" }
    return runStatus ?? agent.effectiveStatus
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
