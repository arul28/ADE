import Foundation

public struct AttentionMachine: Codable, Equatable, Sendable {
    public let machineKey: String
    public let name: String
    public let online: Bool
    public let lastSeenAt: String?

    public init(machineKey: String, name: String, online: Bool, lastSeenAt: String?) {
        self.machineKey = machineKey
        self.name = name
        self.online = online
        self.lastSeenAt = lastSeenAt
    }
}

public struct AttentionProject: Codable, Equatable, Sendable {
    public let projectId: String
    public let name: String
    public let rootPath: String?

    public init(projectId: String, name: String, rootPath: String? = nil) {
        self.projectId = projectId
        self.name = name
        self.rootPath = rootPath
    }
}

public struct AttentionPlanProgress: Codable, Equatable, Sendable {
    public let completed: Int
    public let total: Int
    public let current: String?

    public init(completed: Int, total: Int, current: String? = nil) {
        self.completed = completed
        self.total = total
        self.current = current
    }
}

/// Mirrors ADE's tagged AttentionDestination contract while remaining forward-compatible.
public struct AttentionDestination: Codable, Equatable, Sendable {
    public let kind: String
    public let sessionId: String?
    public let itemId: String?
    public let eventId: String?
    public let prId: String?
    public let repoOwner: String?
    public let repoName: String?
    public let number: Int?
    public let tab: String?

    public init(
        kind: String,
        sessionId: String? = nil,
        itemId: String? = nil,
        eventId: String? = nil,
        prId: String? = nil,
        repoOwner: String? = nil,
        repoName: String? = nil,
        number: Int? = nil,
        tab: String? = nil
    ) {
        self.kind = kind
        self.sessionId = sessionId
        self.itemId = itemId
        self.eventId = eventId
        self.prId = prId
        self.repoOwner = repoOwner
        self.repoName = repoName
        self.number = number
        self.tab = tab
    }

    public var deepLink: String? {
        var components = URLComponents()
        components.scheme = "ade"

        if kind == "session", let sessionId {
            components.host = "session"
            components.path = "/\(sessionId)"
            components.queryItems = [
                itemId.map { URLQueryItem(name: "item", value: $0) },
                eventId.map { URLQueryItem(name: "event", value: $0) },
            ].compactMap { $0 }
            return components.url?.absoluteString
        }

        guard kind == "pull_request", let number else { return nil }
        components.host = "pr"
        if let repoOwner, let repoName {
            components.path = "/\(repoOwner)/\(repoName)/\(number)"
        } else {
            components.path = "/\(number)"
        }
        components.queryItems = [
            (tab != nil && tab != "overview") ? URLQueryItem(name: "tab", value: tab) : nil,
            eventId.map { URLQueryItem(name: "event", value: $0) },
        ].compactMap { $0 }
        return components.url?.absoluteString
    }
}

public struct AttentionAction: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let kind: String
    public let label: String
    public let destructive: Bool?
    public let payload: [String: AttentionJSONValue]?

    public init(
        id: String,
        kind: String,
        label: String,
        destructive: Bool? = nil,
        payload: [String: AttentionJSONValue]? = nil
    ) {
        self.id = id
        self.kind = kind
        self.label = label
        self.destructive = destructive
        self.payload = payload
    }

    public var opensDestination: Bool {
        switch kind {
        case "approve", "deny", "answer", "restart", "rerun_checks", "open":
            return true
        default:
            return false
        }
    }

    public var navigationLabel: String {
        switch kind {
        case "approve": return "Open to approve"
        case "deny": return "Open to deny"
        case "answer": return "Open to answer"
        case "restart": return "Open to restart"
        case "rerun_checks": return "Open to rerun checks"
        case "open": return "Open in ADE"
        default: return "Open in ADE"
        }
    }

    public var navigationAccessibilityHint: String {
        kind == "open"
            ? "Opens the exact item in ADE"
            : "\(navigationLabel) in ADE"
    }
}

public enum AttentionJSONValue: Codable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else {
            self = .string(try container.decode(String.self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}

public struct AttentionItem: Codable, Equatable, Sendable, Identifiable {
    public let contractVersion: Int
    public let id: String
    public let revision: Int
    public let fingerprint: String
    public let kind: String
    public let eventKind: String
    public let phase: String
    public let machine: AttentionMachine
    public let project: AttentionProject
    public let laneId: String?
    public let laneName: String?
    public let provider: String?
    public let model: String?
    public let title: String
    public let preview: String
    public let privacyPreview: String
    public let detail: String?
    public let recentActivity: [String]?
    public let planProgress: AttentionPlanProgress?
    public let destination: AttentionDestination
    public let actions: [AttentionAction]
    public let occurredAt: String
    public let updatedAt: String
    public let seenAt: String?
    public let dismissedAt: String?
    public let expiresAt: String?

    public init(
        contractVersion: Int = 1,
        id: String,
        revision: Int = 1,
        fingerprint: String,
        kind: String,
        eventKind: String,
        phase: String,
        machine: AttentionMachine,
        project: AttentionProject,
        laneId: String? = nil,
        laneName: String? = nil,
        provider: String? = nil,
        model: String? = nil,
        title: String,
        preview: String,
        privacyPreview: String,
        detail: String? = nil,
        recentActivity: [String]? = nil,
        planProgress: AttentionPlanProgress? = nil,
        destination: AttentionDestination,
        actions: [AttentionAction] = [],
        occurredAt: String,
        updatedAt: String,
        seenAt: String? = nil,
        dismissedAt: String? = nil,
        expiresAt: String? = nil
    ) {
        self.contractVersion = contractVersion
        self.id = id
        self.revision = revision
        self.fingerprint = fingerprint
        self.kind = kind
        self.eventKind = eventKind
        self.phase = phase
        self.machine = machine
        self.project = project
        self.laneId = laneId
        self.laneName = laneName
        self.provider = provider
        self.model = model
        self.title = title
        self.preview = preview
        self.privacyPreview = privacyPreview
        self.detail = detail
        self.recentActivity = recentActivity
        self.planProgress = planProgress
        self.destination = destination
        self.actions = actions
        self.occurredAt = occurredAt
        self.updatedAt = updatedAt
        self.seenAt = seenAt
        self.dismissedAt = dismissedAt
        self.expiresAt = expiresAt
    }

    public var isAttention: Bool {
        switch phase {
        case "needs_you", "failed", "checks_failing", "changes_requested",
             "review_requested", "merge_ready":
            return true
        default:
            return false
        }
    }

    public var isCelebration: Bool {
        eventKind == "pr_merged" && phase == "merged" && seenAt == nil
    }

    public var statusLabel: String {
        switch phase {
        case "starting": return "Starting"
        case "running": return "Working"
        case "needs_you": return "Needs you"
        case "blocked": return "Blocked"
        case "failed": return "Failed"
        case "checks_failing": return "Checks failing"
        case "changes_requested": return "Changes requested"
        case "review_requested": return "Review requested"
        case "merge_ready": return "Ready to merge"
        case "completed": return "Completed"
        case "merged": return "Merged"
        default:
            return phase.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    public func presentation(hideDetails: Bool) -> AttentionItemPresentation {
        if hideDetails {
            let genericTitle = kind == "pull_request" ? "Pull request update" : "Agent update"
            return AttentionItemPresentation(
                title: genericTitle,
                preview: privacyPreview,
                compactIdentity: "ADE",
                scopeLabel: "Private details hidden",
                recentActivity: [],
                planProgress: nil,
                celebrationTitle: genericTitle,
                accessibilitySummary: "\(statusLabel). \(privacyPreview)"
            )
        }

        let trimmedLane = laneName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let trimmedProject = project.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let compactIdentity = !trimmedLane.isEmpty
            ? trimmedLane
            : (!trimmedProject.isEmpty ? trimmedProject : title)
        return AttentionItemPresentation(
            title: title,
            preview: preview,
            compactIdentity: compactIdentity,
            scopeLabel: "\(project.name) · \(machine.name)",
            recentActivity: recentActivity ?? [],
            planProgress: planProgress,
            celebrationTitle: title,
            accessibilitySummary: "\(statusLabel), \(title), \(project.name) on \(machine.name)"
        )
    }
}

public struct AttentionItemPresentation: Equatable, Sendable {
    public let title: String
    public let preview: String
    public let compactIdentity: String
    public let scopeLabel: String
    public let recentActivity: [String]
    public let planProgress: AttentionPlanProgress?
    public let celebrationTitle: String
    public let accessibilitySummary: String
}

public enum NotchStatusTone: String, Equatable, Sendable {
    case blue
    case amber
    case red
    case violet
    case green
    case neutral
}

public func notchStatusTone(for phase: String?) -> NotchStatusTone {
    switch phase {
    case "starting", "running", "open":
        return .blue
    case "needs_you", "blocked":
        return .amber
    case "failed", "checks_failing", "changes_requested":
        return .red
    case "review_requested":
        return .violet
    case "completed", "merged", "merge_ready":
        return .green
    default:
        return .neutral
    }
}

public struct AttentionSnapshot: Codable, Equatable, Sendable {
    public let contractVersion: Int
    public let revision: Int
    public let generatedAt: String
    public let items: [AttentionItem]

    public init(contractVersion: Int = 1, revision: Int, generatedAt: String, items: [AttentionItem]) {
        self.contractVersion = contractVersion
        self.revision = revision
        self.generatedAt = generatedAt
        self.items = items
    }
}

public struct NotchSettings: Codable, Equatable, Sendable {
    public var enabled: Bool
    public var preferredDisplayId: UInt32?
    public var hideDetails: Bool
    public var celebrationsEnabled: Bool
    public var soundsEnabled: Bool

    public init(
        enabled: Bool = false,
        preferredDisplayId: UInt32? = nil,
        hideDetails: Bool = true,
        celebrationsEnabled: Bool = true,
        soundsEnabled: Bool = false
    ) {
        self.enabled = enabled
        self.preferredDisplayId = preferredDisplayId
        self.hideDetails = hideDetails
        self.celebrationsEnabled = celebrationsEnabled
        self.soundsEnabled = soundsEnabled
    }
}

public enum NotchInput: Equatable, Sendable {
    case snapshot(AttentionSnapshot)
    case settings(NotchSettings)
    case visibility(Bool)
    case reanchor
    case quit
}

private struct CommandEnvelope: Decodable {
    let type: String
    let snapshot: AttentionSnapshot?
    let settings: NotchSettings?
    let visible: Bool?
}

public enum NotchInputDecoder {
    public static func decode(line: String, decoder: JSONDecoder = JSONDecoder()) throws -> NotchInput {
        let data = Data(line.utf8)
        if let envelope = try? decoder.decode(CommandEnvelope.self, from: data) {
            switch envelope.type {
            case "snapshot":
                guard let snapshot = envelope.snapshot else { throw NotchProtocolError.missingPayload("snapshot") }
                return .snapshot(snapshot)
            case "settings":
                guard let settings = envelope.settings else { throw NotchProtocolError.missingPayload("settings") }
                return .settings(settings)
            case "visibility":
                guard let visible = envelope.visible else { throw NotchProtocolError.missingPayload("visible") }
                return .visibility(visible)
            case "reanchor": return .reanchor
            case "quit": return .quit
            default: throw NotchProtocolError.unknownCommand(envelope.type)
            }
        }
        return .snapshot(try decoder.decode(AttentionSnapshot.self, from: data))
    }
}

public enum NotchProtocolError: Error, Equatable {
    case missingPayload(String)
    case unknownCommand(String)
}

public struct NotchOutput: Encodable, Equatable, Sendable {
    public let type: String
    public let itemId: String?
    public let action: AttentionAction?
    public let destination: AttentionDestination?
    public let deepLink: String?
    public let message: String?
    public let displayId: UInt32?
    public let surface: String?

    public init(
        type: String,
        itemId: String? = nil,
        action: AttentionAction? = nil,
        destination: AttentionDestination? = nil,
        deepLink: String? = nil,
        message: String? = nil,
        displayId: UInt32? = nil,
        surface: String? = nil
    ) {
        self.type = type
        self.itemId = itemId
        self.action = action
        self.destination = destination
        self.deepLink = deepLink
        self.message = message
        self.displayId = displayId
        self.surface = surface
    }
}
