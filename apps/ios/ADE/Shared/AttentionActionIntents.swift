import AppIntents
import Foundation

/// App-intent actions used by the in-app Attention Drawer.
///
/// The drawer can approve or deny pending input, restart a failed session, and
/// rerun failing PR checks without pushing users back to the computer. The intents
/// route through `ADEIntentCommandBridge` so this file can stay shared without
/// importing `SyncService`.

// MARK: - Cross-target command bridge

public enum ADEIntentCommandKind: String, Codable, Sendable {
    case approveSession
    case denySession
    case restartSession
    case retryPrChecks
}

struct ADEPendingIntentCommand: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var kind: ADEIntentCommandKind
    var payload: [String: String]
    var createdAt: Date
}

@MainActor
public protocol ADEIntentCommandBridge: AnyObject {
    func dispatch(_ kind: ADEIntentCommandKind, payload: [String: Any]) async
}

@MainActor
public enum ADEIntentCommandRegistry {
    static let pendingCommandsKey = "ade.intent.pendingCommands"

    public private(set) static weak var bridge: ADEIntentCommandBridge?

    public static func register(_ bridge: ADEIntentCommandBridge) {
        self.bridge = bridge
        Task { @MainActor in
            await drainPendingCommands()
        }
    }

    static func dispatch(_ kind: ADEIntentCommandKind, payload: [String: Any]) async {
        if let bridge {
            await bridge.dispatch(kind, payload: payload)
            return
        }

        var pending = loadPendingCommands()
        pending.append(ADEPendingIntentCommand(
            id: UUID().uuidString,
            kind: kind,
            payload: stringPayload(from: payload),
            createdAt: Date()
        ))
        storePendingCommands(Array(pending.suffix(20)))
    }

    static func drainPendingCommands() async {
        guard let bridge else { return }
        let pending = loadPendingCommands()
        guard !pending.isEmpty else { return }
        storePendingCommands([])
        for command in pending {
            await bridge.dispatch(command.kind, payload: command.payload)
        }
    }

    static func resetForTesting() {
        bridge = nil
        storePendingCommands([])
    }

    private static func loadPendingCommands() -> [ADEPendingIntentCommand] {
        guard let data = ADESharedContainer.defaults.data(forKey: pendingCommandsKey) else {
            return []
        }
        return (try? JSONDecoder().decode([ADEPendingIntentCommand].self, from: data)) ?? []
    }

    private static func storePendingCommands(_ commands: [ADEPendingIntentCommand]) {
        guard !commands.isEmpty else {
            ADESharedContainer.defaults.removeObject(forKey: pendingCommandsKey)
            ADESharedContainer.defaults.synchronize()
            return
        }
        guard let data = try? JSONEncoder().encode(commands) else { return }
        ADESharedContainer.defaults.set(data, forKey: pendingCommandsKey)
        ADESharedContainer.defaults.synchronize()
    }

    private static func stringPayload(from payload: [String: Any]) -> [String: String] {
        var result: [String: String] = [:]
        for (key, value) in payload {
            if let string = value as? String {
                result[key] = string
            } else if let number = value as? NSNumber {
                result[key] = number.stringValue
            } else {
                result[key] = String(describing: value)
            }
        }
        return result
    }
}

// MARK: - Session actions

/// Conforms to `LiveActivityIntent` (not plain `AppIntent`): an intent fired
/// from a Live Activity button only runs in the APP process — where the
/// command bridge is registered — under that conformance. As a plain AppIntent
/// it would run in the widget extension, where the bridge is nil and the
/// command would sit in the pending queue until the next app launch.
@available(iOS 17.0, *)
public struct ApproveSessionIntent: LiveActivityIntent {
    public static var title: LocalizedStringResource = "Approve"
    public static var description = IntentDescription(
        "Approve the pending action in the current ADE session."
    )
    public static var openAppWhenRun: Bool = false

    @Parameter(title: "Session ID")
    public var sessionId: String

    @Parameter(title: "Item ID", default: "")
    public var itemId: String

    public init() {}

    public init(sessionId: String, itemId: String = "") {
        self.sessionId = sessionId
        self.itemId = itemId
    }

    @MainActor
    public func perform() async throws -> some IntentResult {
        await ADEIntentCommandRegistry.dispatch(
            .approveSession,
            payload: ["sessionId": sessionId, "itemId": itemId]
        )
        return .result()
    }
}

/// See `ApproveSessionIntent` — LiveActivityIntent so the deny runs in-app.
@available(iOS 17.0, *)
public struct DenySessionIntent: LiveActivityIntent {
    public static var title: LocalizedStringResource = "Deny"
    public static var description = IntentDescription(
        "Deny the pending action in the current ADE session."
    )
    public static var openAppWhenRun: Bool = false

    @Parameter(title: "Session ID")
    public var sessionId: String

    @Parameter(title: "Item ID", default: "")
    public var itemId: String

    public init() {}

    public init(sessionId: String, itemId: String = "") {
        self.sessionId = sessionId
        self.itemId = itemId
    }

    @MainActor
    public func perform() async throws -> some IntentResult {
        await ADEIntentCommandRegistry.dispatch(
            .denySession,
            payload: ["sessionId": sessionId, "itemId": itemId]
        )
        return .result()
    }
}

@available(iOS 17.0, *)
public struct RestartSessionIntent: AppIntent {
    public static var title: LocalizedStringResource = "Restart"
    public static var description = IntentDescription(
        "Restart the failed ADE session."
    )
    public static var openAppWhenRun: Bool = false

    @Parameter(title: "Session ID")
    public var sessionId: String

    public init() {}

    public init(sessionId: String) {
        self.sessionId = sessionId
    }

    @MainActor
    public func perform() async throws -> some IntentResult {
        await ADEIntentCommandRegistry.dispatch(
            .restartSession,
            payload: ["sessionId": sessionId]
        )
        return .result()
    }
}

// MARK: - PR actions

@available(iOS 17.0, *)
public struct RetryCheckIntent: AppIntent {
    public static var title: LocalizedStringResource = "Retry checks"
    public static var description = IntentDescription(
        "Retry failing CI checks for the associated pull request."
    )
    public static var openAppWhenRun: Bool = false

    @Parameter(title: "PR Number")
    public var prNumber: Int

    @Parameter(title: "PR ID", default: "")
    public var prId: String

    public init() {}

    public init(prNumber: Int, prId: String = "") {
        self.prNumber = prNumber
        self.prId = prId
    }

    @MainActor
    public func perform() async throws -> some IntentResult {
        await ADEIntentCommandRegistry.dispatch(
            .retryPrChecks,
            payload: ["prNumber": prNumber, "prId": prId]
        )
        return .result()
    }
}
