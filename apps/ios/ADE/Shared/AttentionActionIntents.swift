import AppIntents
import Foundation

/// App-intent actions used by the in-app Attention Drawer.
///
/// The drawer can approve or deny pending input, restart a failed session, and
/// rerun failing PR checks without pushing users back to the Mac. The intents
/// route through `ADEIntentCommandBridge` so this file can stay shared without
/// importing `SyncService`.

// MARK: - Cross-target command bridge

public enum ADEIntentCommandKind: String, Sendable {
    case approveSession
    case denySession
    case restartSession
    case retryPrChecks
}

@MainActor
public protocol ADEIntentCommandBridge: AnyObject {
    func dispatch(_ kind: ADEIntentCommandKind, payload: [String: Any]) async
}

@MainActor
public enum ADEIntentCommandRegistry {
    public private(set) static weak var bridge: ADEIntentCommandBridge?

    public static func register(_ bridge: ADEIntentCommandBridge) {
        self.bridge = bridge
    }

    static func dispatch(_ kind: ADEIntentCommandKind, payload: [String: Any]) async {
        await bridge?.dispatch(kind, payload: payload)
    }
}

// MARK: - Session actions

@available(iOS 17.0, *)
public struct ApproveSessionIntent: AppIntent {
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

@available(iOS 17.0, *)
public struct DenySessionIntent: AppIntent {
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
