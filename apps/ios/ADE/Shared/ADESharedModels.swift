import Foundation

/// Lightweight Codable DTOs shared by the main app and widgets.
///
/// Intentionally decoupled from `RemoteModels.swift` — widgets must not import
/// heavyweight renderer code, and the shapes here only carry what we actually
/// render in the lock-screen widget and in-app attention feed.

public struct AgentSnapshot: Codable, Hashable, Identifiable, Sendable {
    public var id: String { sessionId }

    public let sessionId: String
    /// Provider slug: "claude", "codex", "cursor", "opencode", "google",
    /// "mistral", "deepseek", "xai", "groq". Keyed into `ADESharedTheme`.
    public let provider: String
    /// Specific model id (e.g. "claude-sonnet-5"). Rendered as the LA
    /// subtitle in place of the generic provider slug when present.
    public let modelId: String?
    /// Lane name for this session ("Primary", "feature/x"). Used by the
    /// LA header so the activity reads "ADE · Primary" instead of the
    /// hardcoded "Workspace".
    public let laneName: String?
    /// Goal / session title. May be nil for brand-new sessions.
    public let title: String?
    /// "running" | "idle" | "awaiting_input" | "failed" | "completed".
    public let status: String
    public let awaitingInput: Bool
    public let lastActivityAt: Date
    public let elapsedSeconds: Int
    /// Truncated last-output preview. Always <= ~120 chars.
    public let preview: String?
    /// Current pending input / approval item id when `awaitingInput == true`.
    /// Optional so older snapshots from previous app versions decode cleanly.
    public let pendingInputItemId: String?
    /// 0...1 when derivable; nil when the phase is open-ended.
    public let progress: Double?
    /// "planning" | "development" | "testing" | "validation" | "pr" | ...
    public let phase: String?
    public let toolCalls: Int

    public init(
        sessionId: String,
        provider: String,
        modelId: String? = nil,
        laneName: String? = nil,
        title: String?,
        status: String,
        awaitingInput: Bool,
        lastActivityAt: Date,
        elapsedSeconds: Int,
        preview: String?,
        pendingInputItemId: String? = nil,
        progress: Double?,
        phase: String?,
        toolCalls: Int
    ) {
        self.sessionId = sessionId
        self.provider = provider
        self.modelId = modelId
        self.laneName = laneName
        self.title = title
        self.status = status
        self.awaitingInput = awaitingInput
        self.lastActivityAt = lastActivityAt
        self.elapsedSeconds = elapsedSeconds
        self.preview = preview
        self.pendingInputItemId = pendingInputItemId
        self.progress = progress
        self.phase = phase
        self.toolCalls = toolCalls
    }

    private enum CodingKeys: String, CodingKey {
        case sessionId, provider, modelId, laneName, title, status,
             awaitingInput, lastActivityAt, elapsedSeconds, preview,
             pendingInputItemId, progress, phase, toolCalls
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.sessionId = try c.decode(String.self, forKey: .sessionId)
        self.provider = try c.decode(String.self, forKey: .provider)
        self.modelId = try c.decodeIfPresent(String.self, forKey: .modelId)
        self.laneName = try c.decodeIfPresent(String.self, forKey: .laneName)
        self.title = try c.decodeIfPresent(String.self, forKey: .title)
        self.status = try c.decode(String.self, forKey: .status)
        self.awaitingInput = try c.decode(Bool.self, forKey: .awaitingInput)
        self.lastActivityAt = try c.decode(Date.self, forKey: .lastActivityAt)
        self.elapsedSeconds = try c.decode(Int.self, forKey: .elapsedSeconds)
        self.preview = try c.decodeIfPresent(String.self, forKey: .preview)
        self.pendingInputItemId = try c.decodeIfPresent(String.self, forKey: .pendingInputItemId)
        self.progress = try c.decodeIfPresent(Double.self, forKey: .progress)
        self.phase = try c.decodeIfPresent(String.self, forKey: .phase)
        self.toolCalls = try c.decode(Int.self, forKey: .toolCalls)
    }
}

public struct PrSnapshot: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let number: Int
    public let title: String
    /// "passing" | "failing" | "pending".
    public let checks: String
    /// "approved" | "changes_requested" | "pending".
    public let review: String
    /// "open" | "merged" | "closed".
    public let state: String
    public let mergeReady: Bool
    /// Source branch (headRef), e.g. "feat/auth-refactor". Optional so older
    /// snapshots written before the field was added still decode cleanly.
    public let branch: String?
    /// PR update timestamp from the host. Attention surfaces use this instead
    /// of the snapshot write time so a still-open PR does not re-badge every
    /// time the App Group snapshot is regenerated.
    public let updatedAt: Date?

    public init(
        id: String,
        number: Int,
        title: String,
        checks: String,
        review: String,
        state: String,
        mergeReady: Bool,
        branch: String? = nil,
        updatedAt: Date? = nil
    ) {
        self.id = id
        self.number = number
        self.title = title
        self.checks = checks
        self.review = review
        self.state = state
        self.mergeReady = mergeReady
        self.branch = branch
        self.updatedAt = updatedAt
    }
}

public struct WorkspaceSnapshot: Codable, Hashable, Sendable {
    public let generatedAt: Date
    /// All live chat sessions — running, awaiting-input, and idle. The
    /// lock-screen widget narrows this to currently-producing sessions so old /
    /// pending sessions don't pollute the glance; the in-app Activity drawer
    /// reads the full set.
    public let agents: [AgentSnapshot]
    public let prs: [PrSnapshot]
    /// "connected" | "syncing" | "disconnected".
    public let connection: String
    /// Chats waiting on user input. Surfaced as a count chip, not a row.
    public let awaitingInputCount: Int
    /// Chats connected but not currently producing output.
    public let idleCount: Int
    /// Optional scope carried by account-aware publishers. Older, machine-local
    /// snapshots omit these fields and continue to decode as the current
    /// connected workspace.
    public let machineId: String?
    public let machineName: String?
    public let projectId: String?
    public let projectName: String?

    public init(
        generatedAt: Date,
        agents: [AgentSnapshot],
        prs: [PrSnapshot],
        connection: String,
        awaitingInputCount: Int = 0,
        idleCount: Int = 0,
        machineId: String? = nil,
        machineName: String? = nil,
        projectId: String? = nil,
        projectName: String? = nil
    ) {
        self.generatedAt = generatedAt
        self.agents = agents
        self.prs = prs
        self.connection = connection
        self.awaitingInputCount = awaitingInputCount
        self.idleCount = idleCount
        self.machineId = machineId
        self.machineName = machineName
        self.projectId = projectId
        self.projectName = projectName
    }

    private enum CodingKeys: String, CodingKey {
        case generatedAt, agents, prs, connection, awaitingInputCount, idleCount
        case machineId, machineName, projectId, projectName
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.generatedAt = try c.decode(Date.self, forKey: .generatedAt)
        let decodedAgents = try c.decode([AgentSnapshot].self, forKey: .agents)
        self.agents = decodedAgents
        self.prs = try c.decode([PrSnapshot].self, forKey: .prs)
        self.connection = try c.decode(String.self, forKey: .connection)
        // Fields added later — older snapshots written without them decode cleanly.
        // When absent, derive from `agents` so legacy snapshots don't render
        // as fully idle (runningAgents filters waiting/idle sessions out, so a
        // 0 default would silently drop them from every count chip).
        if let value = try c.decodeIfPresent(Int.self, forKey: .awaitingInputCount) {
            self.awaitingInputCount = value
        } else {
            self.awaitingInputCount = decodedAgents.reduce(into: 0) { count, agent in
                if agent.awaitingInput || agent.status.lowercased() == "awaiting_input" {
                    count += 1
                }
            }
        }
        if let value = try c.decodeIfPresent(Int.self, forKey: .idleCount) {
            self.idleCount = value
        } else {
            self.idleCount = decodedAgents.reduce(into: 0) { count, agent in
                if agent.status.lowercased() == "idle" { count += 1 }
            }
        }
        self.machineId = try c.decodeIfPresent(String.self, forKey: .machineId)
        self.machineName = try c.decodeIfPresent(String.self, forKey: .machineName)
        self.projectId = try c.decodeIfPresent(String.self, forKey: .projectId)
        self.projectName = try c.decodeIfPresent(String.self, forKey: .projectName)
    }

    /// Subset of `agents` that are *actively producing output* right now.
    /// This is what the LA roster, home widget roster, and lock-screen
    /// accessory should render — not the full set, which includes idle and
    /// awaiting-input sessions surfaced via `awaitingInputCount` / `idleCount`.
    public var runningAgents: [AgentSnapshot] {
        agents.filter { agent in
            !agent.awaitingInput
                && agent.status.lowercased() != "idle"
                && agent.status.lowercased() != "ended"
                && agent.status.lowercased() != "completed"
                && agent.status.lowercased() != "failed"
        }
    }

    /// Empty snapshot used by widget previews and first-launch placeholders.
    public static let empty = WorkspaceSnapshot(
        generatedAt: Date(timeIntervalSince1970: 0),
        agents: [],
        prs: [],
        connection: "disconnected"
    )
}

// MARK: - Account attention contract

/// Swift mirror of the versioned account-wide attention contract used by the
/// desktop and relay. The current iOS sync path still writes
/// `WorkspaceSnapshot`; these DTOs let the app and widgets consume an account
/// snapshot as soon as one is available without changing their presentation
/// model again.
public let ADEAttentionContractVersion = 1

public enum AccountAttentionItemKind: RawRepresentable, Codable, Hashable, Sendable {
    case agent
    case pullRequest
    case unrecognized(String)

    public init?(rawValue: String) {
        switch rawValue {
        case "agent": self = .agent
        case "pull_request": self = .pullRequest
        default: self = .unrecognized(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .agent: return "agent"
        case .pullRequest: return "pull_request"
        case .unrecognized(let rawValue): return rawValue
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let rawValue = try container.decode(String.self)
        self = Self(rawValue: rawValue) ?? .unrecognized(rawValue)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

public enum AccountAttentionPhase: RawRepresentable, Codable, Hashable, Sendable {
    case starting
    case running
    case needsYou
    case blocked
    case failed
    case completed
    case stale
    case checksFailing
    case reviewRequested
    case changesRequested
    case mergeReady
    case open
    case merged
    case closed
    case unrecognized(String)

    public init?(rawValue: String) {
        switch rawValue {
        case "starting": self = .starting
        case "running": self = .running
        case "needs_you": self = .needsYou
        case "blocked": self = .blocked
        case "failed": self = .failed
        case "completed": self = .completed
        case "stale": self = .stale
        case "checks_failing": self = .checksFailing
        case "review_requested": self = .reviewRequested
        case "changes_requested": self = .changesRequested
        case "merge_ready": self = .mergeReady
        case "open": self = .open
        case "merged": self = .merged
        case "closed": self = .closed
        default: self = .unrecognized(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .starting: return "starting"
        case .running: return "running"
        case .needsYou: return "needs_you"
        case .blocked: return "blocked"
        case .failed: return "failed"
        case .completed: return "completed"
        case .stale: return "stale"
        case .checksFailing: return "checks_failing"
        case .reviewRequested: return "review_requested"
        case .changesRequested: return "changes_requested"
        case .mergeReady: return "merge_ready"
        case .open: return "open"
        case .merged: return "merged"
        case .closed: return "closed"
        case .unrecognized(let rawValue): return rawValue
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let rawValue = try container.decode(String.self)
        self = Self(rawValue: rawValue) ?? .unrecognized(rawValue)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    fileprivate var isRecognized: Bool {
        if case .unrecognized = self { return false }
        return true
    }

    /// Row copy for the Activity drawer. Same words as `AgentRunPhase.label`
    /// and the desktop sidebar — "Working", not "Running"; "Done", not
    /// "Completed" — so one device never describes one session two ways.
    public var displayLabel: String {
        switch self {
        case .starting: return "Starting"
        case .running: return "Working"
        case .needsYou: return "Needs you"
        case .blocked: return "Blocked"
        case .failed: return "Failed"
        case .completed: return "Done"
        case .stale: return "Stale"
        case .checksFailing: return "Checks failing"
        case .reviewRequested: return "Review requested"
        case .changesRequested: return "Changes requested"
        case .mergeReady: return "Ready to merge"
        case .open: return "Open"
        case .merged: return "Merged"
        case .closed: return "Closed"
        case .unrecognized: return "Unknown"
        }
    }
}

public enum AccountAttentionEventKind: RawRepresentable, Codable, Hashable, Sendable {
    case agentRunning
    case agentNeedsYou
    case agentFailed
    case agentCompleted
    case prChecksFailing
    case prReviewRequested
    case prChangesRequested
    case prMergeReady
    case prMerged
    case prOpened
    case prClosed
    case unrecognized(String)

    public init?(rawValue: String) {
        switch rawValue {
        case "agent_running": self = .agentRunning
        case "agent_needs_you": self = .agentNeedsYou
        case "agent_failed": self = .agentFailed
        case "agent_completed": self = .agentCompleted
        case "pr_checks_failing": self = .prChecksFailing
        case "pr_review_requested": self = .prReviewRequested
        case "pr_changes_requested": self = .prChangesRequested
        case "pr_merge_ready": self = .prMergeReady
        case "pr_merged": self = .prMerged
        case "pr_opened": self = .prOpened
        case "pr_closed": self = .prClosed
        default: self = .unrecognized(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .agentRunning: return "agent_running"
        case .agentNeedsYou: return "agent_needs_you"
        case .agentFailed: return "agent_failed"
        case .agentCompleted: return "agent_completed"
        case .prChecksFailing: return "pr_checks_failing"
        case .prReviewRequested: return "pr_review_requested"
        case .prChangesRequested: return "pr_changes_requested"
        case .prMergeReady: return "pr_merge_ready"
        case .prMerged: return "pr_merged"
        case .prOpened: return "pr_opened"
        case .prClosed: return "pr_closed"
        case .unrecognized(let rawValue): return rawValue
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let rawValue = try container.decode(String.self)
        self = Self(rawValue: rawValue) ?? .unrecognized(rawValue)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

public struct AccountAttentionMachine: Codable, Hashable, Sendable {
    public let machineKey: String
    /// Canonical account-directory/sync relay key. `machineKey` remains the
    /// Attention publisher identity; this key is what exact mobile deep links
    /// use to select the owning remote machine.
    public let accountMachineKey: String?
    public let name: String
    public let online: Bool
    public let lastSeenAt: Date?

    public init(
        machineKey: String,
        accountMachineKey: String? = nil,
        name: String,
        online: Bool,
        lastSeenAt: Date?
    ) {
        self.machineKey = machineKey
        self.accountMachineKey = accountMachineKey
        self.name = name
        self.online = online
        self.lastSeenAt = lastSeenAt
    }
}

public struct AccountAttentionProject: Codable, Hashable, Sendable {
    public let projectId: String
    public let name: String
    public let rootPath: String?

    public init(projectId: String, name: String, rootPath: String? = nil) {
        self.projectId = projectId
        self.name = name
        self.rootPath = rootPath
    }
}

public enum AccountAttentionDestination: Hashable, Sendable {
    case session(sessionId: String, itemId: String?, eventId: String?)
    case pullRequest(
        prId: String?,
        repoOwner: String?,
        repoName: String?,
        number: Int,
        tab: String,
        eventId: String?
    )
    case unrecognized(String)

    public var deepLinkURL: URL? {
        deepLinkURL(accountMachineKey: nil)
    }

    public func deepLinkURL(accountMachineKey: String?) -> URL? {
        let normalizedAccountMachineKey = accountMachineKey?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let machineQueryItem = normalizedAccountMachineKey?.isEmpty == false
            ? URLQueryItem(name: "accountMachineKey", value: normalizedAccountMachineKey)
            : nil
        switch self {
        case .session(let sessionId, let itemId, let eventId):
            guard let encoded = Self.encodePathSegment(sessionId) else { return nil }
            var components = URLComponents(string: "ade://session/\(encoded)")
            let queryItems = [
                itemId.map { URLQueryItem(name: "item", value: $0) },
                eventId.map { URLQueryItem(name: "event", value: $0) },
                machineQueryItem,
            ].compactMap { $0 }
            components?.queryItems = queryItems.isEmpty ? nil : queryItems
            return components?.url

        case .pullRequest(_, let owner, let repo, let number, let tab, let eventId):
            guard number > 0 else { return nil }
            let base: String
            if let owner = Self.encodePathSegment(owner),
               let repo = Self.encodePathSegment(repo) {
                base = "ade://pr/\(owner)/\(repo)/\(number)"
            } else {
                base = "ade://pr/\(number)"
            }
            var components = URLComponents(string: base)
            let queryItems = [
                tab == "overview" ? nil : URLQueryItem(name: "tab", value: tab),
                eventId.map { URLQueryItem(name: "event", value: $0) },
                machineQueryItem,
            ].compactMap { $0 }
            components?.queryItems = queryItems.isEmpty ? nil : queryItems
            return components?.url

        case .unrecognized:
            return nil
        }
    }

    private static func encodePathSegment(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else {
            return nil
        }
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed)
    }
}

extension AccountAttentionDestination: Codable {
    private enum CodingKeys: String, CodingKey {
        case kind, sessionId, itemId, eventId
        case prId, repoOwner, repoName, number, tab
    }

    private enum Kind: String {
        case session
        case pullRequest = "pull_request"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let rawKind = try container.decode(String.self, forKey: .kind)
        switch Kind(rawValue: rawKind) {
        case .some(.session):
            self = .session(
                sessionId: try container.decode(String.self, forKey: .sessionId),
                itemId: try container.decodeIfPresent(String.self, forKey: .itemId),
                eventId: try container.decodeIfPresent(String.self, forKey: .eventId)
            )
        case .some(.pullRequest):
            self = .pullRequest(
                prId: try container.decodeIfPresent(String.self, forKey: .prId),
                repoOwner: try container.decodeIfPresent(String.self, forKey: .repoOwner),
                repoName: try container.decodeIfPresent(String.self, forKey: .repoName),
                number: try container.decode(Int.self, forKey: .number),
                tab: try container.decodeIfPresent(String.self, forKey: .tab) ?? "overview",
                eventId: try container.decodeIfPresent(String.self, forKey: .eventId)
            )
        case .none:
            self = .unrecognized(rawKind)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .session(let sessionId, let itemId, let eventId):
            try container.encode(Kind.session.rawValue, forKey: .kind)
            try container.encode(sessionId, forKey: .sessionId)
            try container.encodeIfPresent(itemId, forKey: .itemId)
            try container.encodeIfPresent(eventId, forKey: .eventId)
        case .pullRequest(let prId, let owner, let repo, let number, let tab, let eventId):
            try container.encode(Kind.pullRequest.rawValue, forKey: .kind)
            try container.encodeIfPresent(prId, forKey: .prId)
            try container.encodeIfPresent(owner, forKey: .repoOwner)
            try container.encodeIfPresent(repo, forKey: .repoName)
            try container.encode(number, forKey: .number)
            try container.encode(tab, forKey: .tab)
            try container.encodeIfPresent(eventId, forKey: .eventId)
        case .unrecognized(let rawKind):
            try container.encode(rawKind, forKey: .kind)
        }
    }
}

public enum AccountAttentionActionKind: RawRepresentable, Codable, Hashable, Sendable {
    case approve
    case deny
    case answer
    case restart
    case rerunChecks
    case markSeen
    case dismiss
    case open
    case unrecognized(String)

    public init?(rawValue: String) {
        switch rawValue {
        case "approve": self = .approve
        case "deny": self = .deny
        case "answer": self = .answer
        case "restart": self = .restart
        case "rerun_checks": self = .rerunChecks
        case "mark_seen": self = .markSeen
        case "dismiss": self = .dismiss
        case "open": self = .open
        default: self = .unrecognized(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .approve: return "approve"
        case .deny: return "deny"
        case .answer: return "answer"
        case .restart: return "restart"
        case .rerunChecks: return "rerun_checks"
        case .markSeen: return "mark_seen"
        case .dismiss: return "dismiss"
        case .open: return "open"
        case .unrecognized(let rawValue): return rawValue
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let rawValue = try container.decode(String.self)
        self = Self(rawValue: rawValue) ?? .unrecognized(rawValue)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

public enum AccountAttentionPayloadValue: Codable, Hashable, Sendable {
    case string(String)
    case integer(Int)
    case number(Double)
    case boolean(Bool)
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .boolean(value)
        } else if let value = try? container.decode(Int.self) {
            self = .integer(value)
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
        case .integer(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .boolean(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}

public struct AccountAttentionAction: Codable, Hashable, Sendable {
    public let id: String
    public let kind: AccountAttentionActionKind
    public let label: String
    public let destructive: Bool?
    public let payload: [String: AccountAttentionPayloadValue]?

    public init(
        id: String,
        kind: AccountAttentionActionKind,
        label: String,
        destructive: Bool? = nil,
        payload: [String: AccountAttentionPayloadValue]? = nil
    ) {
        self.id = id
        self.kind = kind
        self.label = label
        self.destructive = destructive
        self.payload = payload
    }
}

public struct AccountAttentionPlanProgress: Codable, Hashable, Sendable {
    public let completed: Int
    public let total: Int
    public let current: String?

    public init(completed: Int, total: Int, current: String? = nil) {
        self.completed = completed
        self.total = total
        self.current = current
    }
}

public enum AccountActivityTier: String, Codable, Hashable, Sendable {
    case signal
    case ambient
    case idle
}

/// The one optional additive field the Activity state table trusts beyond the
/// frozen phase vocabulary.
///
/// `AccountAttentionPhase` deliberately has no `planning` member — the wire
/// vocabulary is closed, and widening it would have broken every installed
/// build's exhaustive switch. Planning is carried alongside the phase instead,
/// exactly as desktop's `activityChatMode()` reads it.
///
/// Decoded leniently on purpose: any value other than the literal `"planning"`
/// — including a JSON type a newer publisher might send — reads as "not
/// planning" rather than throwing. A throw here would be caught by
/// `FailableDecodable` and drop the WHOLE item, which is a wildly
/// disproportionate outcome for one cosmetic hint.
public enum AccountChatActivityMode: Codable, Hashable, Sendable {
    /// The single value this build acts on: a violet "Planning" row.
    case planning
    /// Anything else, carried verbatim so a re-encode is lossless, and treated
    /// as absent everywhere it is read.
    case unrecognized(String)

    public var isPlanning: Bool {
        if case .planning = self { return true }
        return false
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        guard let raw = try? container.decode(String.self) else {
            self = .unrecognized("")
            return
        }
        self = raw.lowercased() == "planning" ? .planning : .unrecognized(raw)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .planning: try container.encode("planning")
        case .unrecognized(let raw): try container.encode(raw)
        }
    }
}

public struct AccountAttentionItem: Codable, Hashable, Identifiable, Sendable {
    public let contractVersion: Int
    public let id: String
    public let revision: Int
    public let fingerprint: String
    public let kind: AccountAttentionItemKind
    public let eventKind: AccountAttentionEventKind
    public let phase: AccountAttentionPhase
    /// Kept as an optional wire string so future tier values remain additive.
    public let activityTier: String?
    /// Additive planning hint. Absent on every payload from an older publisher,
    /// which is why it is optional rather than defaulted.
    public let chatActivityMode: AccountChatActivityMode?
    public let statusSince: Date?
    public private(set) var machine: AccountAttentionMachine
    public let project: AccountAttentionProject
    public let laneId: String?
    public let laneName: String?
    public let provider: String?
    public let model: String?
    public let title: String
    public let preview: String
    public let privacyPreview: String
    public let detail: String?
    public let recentActivity: [String]?
    public let planProgress: AccountAttentionPlanProgress?
    public let destination: AccountAttentionDestination
    public let actions: [AccountAttentionAction]
    public let occurredAt: Date
    public let updatedAt: Date
    public let seenAt: Date?
    public let dismissedAt: Date?
    public let expiresAt: Date?

    public init(
        contractVersion: Int = ADEAttentionContractVersion,
        id: String,
        revision: Int,
        fingerprint: String,
        kind: AccountAttentionItemKind,
        eventKind: AccountAttentionEventKind,
        phase: AccountAttentionPhase,
        activityTier: String? = nil,
        chatActivityMode: AccountChatActivityMode? = nil,
        statusSince: Date? = nil,
        machine: AccountAttentionMachine,
        project: AccountAttentionProject,
        laneId: String? = nil,
        laneName: String? = nil,
        provider: String? = nil,
        model: String? = nil,
        title: String,
        preview: String,
        privacyPreview: String,
        detail: String? = nil,
        recentActivity: [String]? = nil,
        planProgress: AccountAttentionPlanProgress? = nil,
        destination: AccountAttentionDestination,
        actions: [AccountAttentionAction] = [],
        occurredAt: Date,
        updatedAt: Date,
        seenAt: Date? = nil,
        dismissedAt: Date? = nil,
        expiresAt: Date? = nil
    ) {
        self.contractVersion = contractVersion
        self.id = id
        self.revision = revision
        self.fingerprint = fingerprint
        self.kind = kind
        self.eventKind = eventKind
        self.phase = phase
        self.activityTier = activityTier
        self.chatActivityMode = chatActivityMode
        self.statusSince = statusSince
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

    fileprivate func updatingMachinePresence(
        from presence: AccountAttentionMachine?
    ) -> AccountAttentionItem {
        guard let presence, presence.machineKey == machine.machineKey else {
            return self
        }
        var updated = self
        updated.machine = AccountAttentionMachine(
            machineKey: machine.machineKey,
            accountMachineKey: presence.accountMachineKey ?? machine.accountMachineKey,
            name: presence.name,
            online: presence.online,
            lastSeenAt: presence.lastSeenAt
        )
        return updated
    }

    public var isLive: Bool {
        switch phase {
        case .starting, .running, .needsYou, .blocked, .failed, .stale,
             .checksFailing, .reviewRequested, .changesRequested, .mergeReady:
            return true
        case .open, .completed, .merged, .closed:
            return false
        case .unrecognized:
            return false
        }
    }

    public var tier: AccountActivityTier {
        if let activityTier, let publishedTier = AccountActivityTier(rawValue: activityTier) {
            return publishedTier
        }
        switch phase {
        case .needsYou, .blocked, .failed, .checksFailing, .reviewRequested,
             .changesRequested, .mergeReady:
            return .signal
        case .starting, .running, .completed, .stale, .open, .merged, .closed,
             .unrecognized:
            return .ambient
        }
    }

    public var needsInbox: Bool {
        guard tier != .idle, dismissedAt == nil else { return false }
        switch phase {
        case .needsYou, .failed, .checksFailing, .changesRequested,
             .reviewRequested, .mergeReady:
            return true
        case .completed, .merged:
            return seenAt == nil
        case .starting, .running, .blocked, .open, .stale, .closed:
            return false
        case .unrecognized:
            return false
        }
    }

    public var deepLinkURL: URL? {
        destination.deepLinkURL(accountMachineKey: machine.accountMachineKey)
    }
}

public struct AccountAttentionTombstone: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let revision: Int
    public let deletedAt: Date
}

private struct FailableDecodable<Value: Decodable>: Decodable {
    let value: Value?

    init(from decoder: Decoder) throws {
        value = try? Value(from: decoder)
    }
}

public struct AccountAttentionSnapshot: Codable, Hashable, Sendable {
    public let contractVersion: Int
    /// Opaque account stream identity assigned by Relay. Older relays and
    /// snapshots omit it; once present, a change is an account boundary and
    /// the incoming snapshot must replace—not merge with—the prior stream.
    public let streamId: String?
    public let revision: Int
    public let generatedAt: Date
    /// Current account-machine presence. Relay includes this even when no
    /// attention items changed, so cached items can refresh their scope state.
    public let machines: [AccountAttentionMachine]?
    public let items: [AccountAttentionItem]
    public let tombstones: [AccountAttentionTombstone]?
    public let itemsTruncated: Bool?

    private enum CodingKeys: String, CodingKey {
        case contractVersion
        case streamId
        case revision
        case generatedAt
        case machines
        case items
        case tombstones
        case itemsTruncated
    }

    public init(
        contractVersion: Int = ADEAttentionContractVersion,
        streamId: String? = nil,
        revision: Int,
        generatedAt: Date,
        machines: [AccountAttentionMachine]? = nil,
        items: [AccountAttentionItem],
        tombstones: [AccountAttentionTombstone]? = nil,
        itemsTruncated: Bool? = nil
    ) {
        self.contractVersion = contractVersion
        self.streamId = streamId
        self.revision = revision
        self.generatedAt = generatedAt
        self.machines = machines
        self.items = items
        self.tombstones = tombstones
        self.itemsTruncated = itemsTruncated
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        contractVersion = try container.decode(Int.self, forKey: .contractVersion)
        streamId = try container.decodeIfPresent(String.self, forKey: .streamId)
        revision = try container.decode(Int.self, forKey: .revision)
        generatedAt = try container.decode(Date.self, forKey: .generatedAt)
        machines = try container.decodeIfPresent([AccountAttentionMachine].self, forKey: .machines)
        items = try container.decode(
            [FailableDecodable<AccountAttentionItem>].self,
            forKey: .items
        )
        .compactMap(\.value)
        // Unknown phases cannot be categorized safely by an installed UI.
        // The raw enum value still decodes losslessly, while this one row is
        // omitted instead of invalidating the entire account snapshot.
        .filter { $0.phase.isRecognized }
        tombstones = try container.decodeIfPresent(
            [AccountAttentionTombstone].self,
            forKey: .tombstones
        )
        itemsTruncated = try container.decodeIfPresent(Bool.self, forKey: .itemsTruncated)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(contractVersion, forKey: .contractVersion)
        try container.encodeIfPresent(streamId, forKey: .streamId)
        try container.encode(revision, forKey: .revision)
        try container.encode(generatedAt, forKey: .generatedAt)
        try container.encodeIfPresent(machines, forKey: .machines)
        try container.encode(items, forKey: .items)
        try container.encodeIfPresent(tombstones, forKey: .tombstones)
        try container.encodeIfPresent(itemsTruncated, forKey: .itemsTruncated)
    }

    /// Apply an incremental relay response to the last full snapshot. Relay
    /// deltas contain only items/tombstones newer than `since`; merging here
    /// keeps widgets and the app backed by one complete App Group snapshot.
    public func merging(_ delta: AccountAttentionSnapshot) -> AccountAttentionSnapshot {
        guard delta.contractVersion == contractVersion else {
            return self
        }
        // A non-nil Relay stream id is authoritative. nil remains compatible
        // with snapshots from older servers, while nil -> value intentionally
        // resets any legacy/unknown account data.
        if let incomingStreamId = delta.streamId,
           incomingStreamId != streamId {
            return normalizedAccountAttentionSnapshot(delta)
        }
        guard delta.revision >= revision else { return self }
        var byId = Dictionary(items.map { ($0.id, $0) }) { lhs, rhs in
            rhs.revision > lhs.revision ? rhs : lhs
        }
        for item in delta.items {
            if let existing = byId[item.id], existing.revision > item.revision {
                continue
            }
            byId[item.id] = item
        }
        for tombstone in delta.tombstones ?? [] {
            guard let existing = byId[tombstone.id],
                  existing.revision <= tombstone.revision else {
                continue
            }
            byId.removeValue(forKey: tombstone.id)
        }
        return normalizedAccountAttentionSnapshot(AccountAttentionSnapshot(
            contractVersion: contractVersion,
            streamId: delta.streamId ?? streamId,
            revision: delta.revision,
            generatedAt: delta.generatedAt,
            machines: delta.machines ?? machines,
            items: Array(byId.values),
            tombstones: delta.tombstones,
            itemsTruncated: delta.itemsTruncated ?? itemsTruncated
        ))
    }
}

private func normalizedAccountAttentionSnapshot(
    _ snapshot: AccountAttentionSnapshot
) -> AccountAttentionSnapshot {
    let machinesByKey = Dictionary(
        (snapshot.machines ?? []).map { ($0.machineKey, $0) },
        uniquingKeysWith: { _, latest in latest }
    )
    let itemsById = Dictionary(snapshot.items.map { item in
        (
            item.id,
            item.updatingMachinePresence(from: machinesByKey[item.machine.machineKey])
        )
    }) { lhs, rhs in
        rhs.revision > lhs.revision ? rhs : lhs
    }
    return AccountAttentionSnapshot(
        contractVersion: snapshot.contractVersion,
        streamId: snapshot.streamId,
        revision: snapshot.revision,
        generatedAt: snapshot.generatedAt,
        machines: snapshot.machines,
        items: Array(itemsById.values),
        tombstones: snapshot.tombstones,
        itemsTruncated: snapshot.itemsTruncated
    )
}

/// Centralizes the read-before-commit merge used by account Attention refresh.
/// Re-reading at commit time prevents a slower rev11 request from overwriting a
/// rev12 snapshot that completed while it was suspended on the network.
public func accountAttentionSnapshotForCommit(
    current: AccountAttentionSnapshot?,
    incoming: AccountAttentionSnapshot
) -> AccountAttentionSnapshot {
    current?.merging(incoming) ?? normalizedAccountAttentionSnapshot(incoming)
}
