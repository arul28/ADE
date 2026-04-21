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

    public init(
        id: String,
        number: Int,
        title: String,
        checks: String,
        review: String,
        state: String,
        mergeReady: Bool
    ) {
        self.id = id
        self.number = number
        self.title = title
        self.checks = checks
        self.review = review
        self.state = state
        self.mergeReady = mergeReady
    }
}

public struct WorkspaceSnapshot: Codable, Hashable, Sendable {
    public let generatedAt: Date
    public let agents: [AgentSnapshot]
    public let prs: [PrSnapshot]
    /// "connected" | "syncing" | "disconnected".
    public let connection: String

    public init(
        generatedAt: Date,
        agents: [AgentSnapshot],
        prs: [PrSnapshot],
        connection: String
    ) {
        self.generatedAt = generatedAt
        self.agents = agents
        self.prs = prs
        self.connection = connection
    }

    /// Empty snapshot used by widget previews and first-launch placeholders.
    public static let empty = WorkspaceSnapshot(
        generatedAt: Date(timeIntervalSince1970: 0),
        agents: [],
        prs: [],
        connection: "disconnected"
    )
}
