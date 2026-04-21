import AppIntents
import Foundation

/// Widget configuration intents. These let users pin a specific session to a
/// small widget and surface suggestions in the Shortcuts app.
///
/// Compiled into the main ADE target, the ADEWidgets extension, and the
/// ADENotificationService extension for symbol parity across processes that
/// host interactive regions. The underlying data source (`ADESharedContainer
/// .readWorkspaceSnapshot()`) is populated by the main app and read by the
/// extensions via the App Group.

// MARK: - SessionEntity

@available(iOS 17.0, *)
public struct SessionEntity: AppEntity, Identifiable {
    public let id: String
    public let sessionTitle: String
    public let providerSlug: String
    public let status: String

    public init(id: String, sessionTitle: String, providerSlug: String, status: String) {
        self.id = id
        self.sessionTitle = sessionTitle
        self.providerSlug = providerSlug
        self.status = status
    }

    public static var typeDisplayRepresentation: TypeDisplayRepresentation {
        TypeDisplayRepresentation(name: "ADE Session")
    }

    public var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(
            title: "\(sessionTitle)",
            subtitle: "\(providerSlug) · \(status)"
        )
    }

    public static var defaultQuery: SessionEntityQuery { SessionEntityQuery() }

    /// Build from an `AgentSnapshot` — the canonical roster entry written by
    /// the main app into the App Group snapshot blob.
    public static func from(_ snapshot: AgentSnapshot) -> SessionEntity {
        SessionEntity(
            id: snapshot.sessionId,
            sessionTitle: (snapshot.title?.isEmpty == false ? snapshot.title! : snapshot.sessionId),
            providerSlug: snapshot.provider,
            status: snapshot.status
        )
    }
}

// MARK: - SessionEntityQuery

@available(iOS 17.0, *)
public struct SessionEntityQuery: EntityQuery {
    public init() {}

    public func entities(for ids: [SessionEntity.ID]) async throws -> [SessionEntity] {
        let agents = ADESharedContainer.readWorkspaceSnapshot()?.agents ?? []
        let byId = Dictionary(uniqueKeysWithValues: agents.map { ($0.sessionId, $0) })
        return ids.compactMap { id in
            guard let snap = byId[id] else { return nil }
            return SessionEntity.from(snap)
        }
    }

    public func suggestedEntities() async throws -> [SessionEntity] {
        let agents = ADESharedContainer.readWorkspaceSnapshot()?.agents ?? []
        return agents.map(SessionEntity.from)
    }
}

// MARK: - SelectSessionIntent

/// Widget configuration intent — used by small widgets that let the user
/// pin a single session. The widget extension reads the resolved
/// `session.id` from the intent and renders that specific row.
@available(iOS 17.0, *)
public struct SelectSessionIntent: AppIntent, WidgetConfigurationIntent {
    public static var title: LocalizedStringResource = "Select Session"
    public static var description = IntentDescription(
        "Pick which ADE session the widget should display."
    )

    @Parameter(title: "Session")
    public var session: SessionEntity?

    public init() {}

    public init(session: SessionEntity?) {
        self.session = session
    }

    public func perform() async throws -> some IntentResult {
        return .result()
    }
}
