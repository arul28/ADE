import Foundation

/// Lightweight Codable DTOs shared by the main app, widgets, and the
/// notification service extension.
///
/// Intentionally decoupled from `RemoteModels.swift` — widgets must not import
/// heavyweight renderer code, and the shapes here only carry what we actually
/// render on a lock screen / live activity.

public struct AgentSnapshot: Codable, Hashable, Identifiable, Sendable {
    public var id: String { sessionId }

    public let sessionId: String
    /// Provider slug: "claude", "codex", "cursor", "opencode", "google",
    /// "mistral", "deepseek", "xai", "groq". Keyed into `ADESharedTheme`.
    public let provider: String
    /// Goal / session title. May be nil for brand-new sessions.
    public let title: String?
    /// "running" | "idle" | "awaiting_input" | "failed" | "completed".
    public let status: String
    public let awaitingInput: Bool
    public let lastActivityAt: Date
    public let elapsedSeconds: Int
    /// Truncated last-output preview. Always <= ~120 chars.
    public let preview: String?
    /// 0...1 when derivable; nil when the phase is open-ended.
    public let progress: Double?
    /// "planning" | "development" | "testing" | "validation" | "pr" | ...
    public let phase: String?
    public let toolCalls: Int

    public init(
        sessionId: String,
        provider: String,
        title: String?,
        status: String,
        awaitingInput: Bool,
        lastActivityAt: Date,
        elapsedSeconds: Int,
        preview: String?,
        progress: Double?,
        phase: String?,
        toolCalls: Int
    ) {
        self.sessionId = sessionId
        self.provider = provider
        self.title = title
        self.status = status
        self.awaitingInput = awaitingInput
        self.lastActivityAt = lastActivityAt
        self.elapsedSeconds = elapsedSeconds
        self.preview = preview
        self.progress = progress
        self.phase = phase
        self.toolCalls = toolCalls
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

    public init(
        id: String,
        number: Int,
        title: String,
        checks: String,
        review: String,
        state: String,
        mergeReady: Bool,
        branch: String? = nil
    ) {
        self.id = id
        self.number = number
        self.title = title
        self.checks = checks
        self.review = review
        self.state = state
        self.mergeReady = mergeReady
        self.branch = branch
    }
}

public struct WorkspaceSnapshot: Codable, Hashable, Sendable {
    public let generatedAt: Date
    /// All live chat sessions — running, awaiting-input, and idle. Widgets and
    /// the Live Activity render `runningAgents` (only currently-producing
    /// sessions) so old / pending sessions don't pollute the roster; the
    /// in-app Attention Drawer reads the full set.
    public let agents: [AgentSnapshot]
    public let prs: [PrSnapshot]
    /// "connected" | "syncing" | "disconnected".
    public let connection: String
    /// Chats waiting on user input. Surfaced as a count chip, not a row.
    public let awaitingInputCount: Int
    /// Chats connected but not currently producing output.
    public let idleCount: Int

    public init(
        generatedAt: Date,
        agents: [AgentSnapshot],
        prs: [PrSnapshot],
        connection: String,
        awaitingInputCount: Int = 0,
        idleCount: Int = 0
    ) {
        self.generatedAt = generatedAt
        self.agents = agents
        self.prs = prs
        self.connection = connection
        self.awaitingInputCount = awaitingInputCount
        self.idleCount = idleCount
    }

    private enum CodingKeys: String, CodingKey {
        case generatedAt, agents, prs, connection, awaitingInputCount, idleCount
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
